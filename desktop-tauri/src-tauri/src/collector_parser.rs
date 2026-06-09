use crate::database::{now_iso, Database};
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

pub fn process_payload(
    db: &Arc<Database>,
    source_url: &str,
    payload: Value,
) -> Result<usize, String> {
    let matches = find_matches(&payload);
    let match_count = matches.len();
    if match_count > 0 {
        db.ingest_matches(Value::Array(matches))?;
    }

    let lower_url = source_url.to_ascii_lowercase();
    if lower_url.contains("/player-stats/games/dbd/providers/") {
        if let Some(data) = payload.get("data") {
            db.ingest_official_sections(json!({
                "data": data,
                "section": if lower_url.contains("matchcategory=regular") { "regular-trials" } else { "overview" },
                "captured_at": now_iso()
            }))?;
        }
    }

    db.ingest_snapshots(json!([{
        "source_url": source_url,
        "kind": if match_count > 0 { "match-history" } else if lower_url.contains("/player-stats/games") { "regular-trials" } else { "statistics" },
        "captured_at": now_iso(),
        "raw": payload
    }]))?;

    Ok(match_count)
}

fn find_matches(payload: &Value) -> Vec<Value> {
    let mut found = Vec::new();
    let mut seen_ptrs = HashSet::new();
    walk(payload, 0, &mut seen_ptrs, &mut found);

    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|item| {
            let key = format!(
                "{}|{}|{}",
                text(item.get("source_id")).unwrap_or_default(),
                text(item.get("played_at")).unwrap_or_default(),
                text(item.get("character")).unwrap_or_default()
            );
            seen.insert(key)
        })
        .collect()
}

fn walk(value: &Value, depth: usize, seen_ptrs: &mut HashSet<usize>, found: &mut Vec<Value>) {
    if depth > 8 {
        return;
    }
    let ptr = value as *const Value as usize;
    if !seen_ptrs.insert(ptr) {
        return;
    }
    if let Some(match_value) = normalize_match(value) {
        found.push(match_value);
        return;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .for_each(|item| walk(item, depth + 1, seen_ptrs, found)),
        Value::Object(map) => map
            .values()
            .for_each(|item| walk(item, depth + 1, seen_ptrs, found)),
        _ => {}
    }
}

fn normalize_match(source: &Value) -> Option<Value> {
    normalize_official_match(source)
}

fn normalize_official_match(source: &Value) -> Option<Value> {
    let match_stat = source.get("matchStat")?;
    let player = source.get("playerStat")?;
    let opponents = source.get("opponentStat")?.as_array()?;
    let player_role = role(player.get("playerRole"))?;
    let survivors: Vec<&Value> = if player_role == "killer" {
        opponents.iter().collect()
    } else {
        std::iter::once(player)
            .chain(
                opponents
                    .iter()
                    .filter(|item| role(item.get("playerRole")).as_deref() == Some("survivor")),
            )
            .collect()
    };
    let kills = survivors
        .iter()
        .filter(|item| {
            text(item.get("playerStatus"))
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains_any(&["sacrificed", "killed", "mori", "dead"])
        })
        .count();
    let killer = if player_role == "survivor" {
        opponents
            .iter()
            .find(|item| role(item.get("playerRole")).as_deref() == Some("killer"))
    } else {
        Some(player)
    };
    let character = text(player.get("characterName"));
    let played_at = date(match_stat.get("matchStartTime"))?;

    Some(json!({
        "source_id": format!("{}|{}|{}", text(match_stat.get("matchStartTime")).unwrap_or_default(), text(match_stat.get("mapName")).unwrap_or_default(), character.clone().unwrap_or_default()),
        "played_at": played_at,
        "role": player_role,
        "character": character,
        "map": text(match_stat.get("map")).or_else(|| text(match_stat.get("mapName"))),
        "duration_sec": number(match_stat.get("matchDuration")).unwrap_or_default().round() as i64,
        "result": if player_role == "killer" { Some(format!("{kills}K")) } else { text(player.get("playerStatus")) },
        "score": number(player.get("bloodpointsEarned")).map(|n| n.round() as i64),
        "loadout": official_loadout(player),
        "killer_info": killer.map(|killer| json!({
            "killer": text(killer.get("characterName")),
            "kills_count": kills,
            "perks": names(killer.pointer("/characterLoadout/perks")),
            "addons": names(killer.pointer("/characterLoadout/addOns")),
            "offering": text(killer.pointer("/characterLoadout/offering"))
        })),
        "participants": opponents.iter().map(|item| json!({
            "character": text(item.get("characterName")),
            "role": role(item.get("playerRole")).unwrap_or_else(|| "survivor".to_string()),
            "result": text(item.get("playerStatus")),
            "score": number(item.get("bloodpointsEarned")).map(|n| n.round() as i64),
            "perks": names(item.pointer("/characterLoadout/perks")),
            "item": text(item.pointer("/characterLoadout/power")),
            "addons": names(item.pointer("/characterLoadout/addOns")),
            "offering": text(item.pointer("/characterLoadout/offering"))
        })).collect::<Vec<_>>(),
        "raw": source
    }))
}

fn official_loadout(player: &Value) -> Value {
    json!({
        "perks": names(player.pointer("/characterLoadout/perks")),
        "item": text(player.pointer("/characterLoadout/power")),
        "addons": names(player.pointer("/characterLoadout/addOns")),
        "offering": text(player.pointer("/characterLoadout/offering"))
    })
}

fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| text(Some(item))).collect())
        .unwrap_or_default()
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Object(map) => ["name", "label", "title", "displayName"]
            .iter()
            .find_map(|key| text(map.get(*key))),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.replace([',', ' '], "").parse().ok(),
        _ => None,
    }
}

fn role(value: Option<&Value>) -> Option<String> {
    let value = text(value)?.to_ascii_lowercase();
    if value.contains("ve_slasher") || value.contains("killer") || value.contains("assass") {
        Some("killer".to_string())
    } else if value.contains("ve_camper")
        || value.contains("survivor")
        || value.contains("sobreviv")
    {
        Some("survivor".to_string())
    } else {
        None
    }
}

fn date(value: Option<&Value>) -> Option<String> {
    let raw = text(value)?;
    if raw.contains('T') {
        return Some(raw);
    }
    number(Some(&Value::String(raw))).map(|number| {
        let millis = if number < 10_000_000_000.0 {
            number * 1000.0
        } else {
            number
        };
        let seconds = (millis / 1000.0) as i64;
        time::OffsetDateTime::from_unix_timestamp(seconds)
            .ok()
            .and_then(|dt| {
                dt.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            })
            .unwrap_or_else(now_iso)
    })
}

trait ContainsAny {
    fn contains_any(&self, patterns: &[&str]) -> bool;
}

impl ContainsAny for str {
    fn contains_any(&self, patterns: &[&str]) -> bool {
        patterns.iter().any(|pattern| self.contains(pattern))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_official_match_payloads() {
        let payload = json!({
            "data": [{
                "matchStat": {
                    "matchStartTime": "2026-06-08T12:00:00Z",
                    "mapName": "Dead Dawg Saloon",
                    "matchDuration": 610
                },
                "playerStat": {
                    "playerRole": "VE_Camper",
                    "characterName": { "name": "Meg Thomas" },
                    "playerStatus": "Escaped",
                    "bloodpointsEarned": 28000,
                    "characterLoadout": { "perks": [{ "name": "Sprint Burst" }], "addOns": [] }
                },
                "opponentStat": [{
                    "playerRole": "VE_Slasher",
                    "characterName": { "name": "The Trapper" },
                    "playerStatus": "Killer",
                    "bloodpointsEarned": 24000,
                    "characterLoadout": { "perks": [{ "name": "Brutal Strength" }], "addOns": [] }
                }]
            }]
        });

        let matches = find_matches(&payload);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["role"], "survivor");
        assert_eq!(matches[0]["character"], "Meg Thomas");
    }
}
