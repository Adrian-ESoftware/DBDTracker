use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const ASSET_BASE: &str = "https://assets.live.bhvraccount.com/";

pub type DbResult<T> = Result<T, String>;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &std::path::Path) -> DbResult<Self> {
        let conn = Connection::open(path).map_err(to_string)?;
        init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory().map_err(to_string)?;
        init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn ingest_matches(&self, value: Value) -> DbResult<Value> {
        let items = value
            .as_array()
            .ok_or("payload de partidas deve ser uma lista")?;
        let mut conn = self.conn.lock().map_err(to_string)?;
        let tx = conn.transaction().map_err(to_string)?;
        let mut inserted = 0;
        let mut updated = 0;

        {
            let mut upsert = tx.prepare(
                "INSERT INTO matches
                (id,source_id,played_at,role,character,map,map_realm,duration_sec,result,score,raw_json,imported_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,played_at=excluded.played_at,
                role=excluded.role,character=excluded.character,map=excluded.map,map_realm=excluded.map_realm,
                duration_sec=excluded.duration_sec,result=excluded.result,score=excluded.score,raw_json=excluded.raw_json"
            ).map_err(to_string)?;
            let mut add_loadout = tx
                .prepare("INSERT INTO loadouts VALUES (?,?,?,?,?)")
                .map_err(to_string)?;
            let mut add_killer = tx
                .prepare("INSERT INTO killer_info VALUES (?,?,?,?,?,?)")
                .map_err(to_string)?;
            let mut add_participant = tx
                .prepare(
                    "INSERT INTO participants
                (match_id,character,role,result,score,perks_json,item,addons_json,offering)
                VALUES (?,?,?,?,?,?,?,?,?)",
                )
                .map_err(to_string)?;

            for item in items {
                let id = id_for(item);
                let exists: Option<String> = tx
                    .query_row("SELECT id FROM matches WHERE id=?", [&id], |row| row.get(0))
                    .optional()
                    .map_err(to_string)?;
                if exists.is_some() {
                    updated += 1;
                } else {
                    inserted += 1;
                }

                let loadout = item.get("loadout").unwrap_or(&Value::Null);
                let killer = item.get("killer_info").unwrap_or(&Value::Null);
                upsert
                    .execute(params![
                        id,
                        str_field(item, "source_id"),
                        str_field(item, "played_at").unwrap_or_default(),
                        str_field(item, "role").unwrap_or_else(|| "survivor".to_string()),
                        str_field(item, "character"),
                        str_field(item, "map"),
                        str_field(item, "map_realm"),
                        int_field(item, "duration_sec"),
                        str_field(item, "result"),
                        int_field(item, "score"),
                        item.get("raw").map(json_text),
                        now_iso()
                    ])
                    .map_err(to_string)?;

                if let Some(raw) = item.get("raw") {
                    index_assets(&tx, raw)?;
                }

                for table in ["loadouts", "killer_info", "participants"] {
                    tx.execute(&format!("DELETE FROM {table} WHERE match_id=?"), [&id])
                        .map_err(to_string)?;
                }
                add_loadout
                    .execute(params![
                        id,
                        json_text(loadout.get("perks").unwrap_or(&json!([]))),
                        str_field(loadout, "item"),
                        json_text(loadout.get("addons").unwrap_or(&json!([]))),
                        str_field(loadout, "offering")
                    ])
                    .map_err(to_string)?;
                if killer.is_object() {
                    add_killer
                        .execute(params![
                            id,
                            str_field(killer, "killer"),
                            int_field(killer, "kills_count"),
                            json_text(killer.get("perks").unwrap_or(&json!([]))),
                            json_text(killer.get("addons").unwrap_or(&json!([]))),
                            str_field(killer, "offering")
                        ])
                        .map_err(to_string)?;
                }
                if let Some(participants) = item.get("participants").and_then(Value::as_array) {
                    for p in participants {
                        add_participant
                            .execute(params![
                                id,
                                str_field(p, "character"),
                                str_field(p, "role").unwrap_or_else(|| "survivor".to_string()),
                                str_field(p, "result"),
                                int_field(p, "score"),
                                json_text(p.get("perks").unwrap_or(&json!([]))),
                                str_field(p, "item"),
                                json_text(p.get("addons").unwrap_or(&json!([]))),
                                str_field(p, "offering")
                            ])
                            .map_err(to_string)?;
                    }
                }
            }
        }

        tx.commit().map_err(to_string)?;
        Ok(json!({ "received": items.len(), "inserted": inserted, "updated": updated }))
    }

    pub fn ingest_snapshots(&self, value: Value) -> DbResult<Value> {
        let items = value
            .as_array()
            .ok_or("payload de snapshots deve ser uma lista")?;
        let conn = self.conn.lock().map_err(to_string)?;
        let mut insert = conn
            .prepare("INSERT OR IGNORE INTO source_snapshots VALUES (?,?,?,?,?)")
            .map_err(to_string)?;
        let mut inserted = 0;
        for item in items {
            let raw = json_text(item.get("raw").unwrap_or(&Value::Null));
            let source_url = str_field(item, "source_url").unwrap_or_default();
            let captured_at = str_field(item, "captured_at").unwrap_or_else(now_iso);
            let id = hash(&format!("{source_url}|{captured_at}|{raw}"));
            inserted += insert
                .execute(params![
                    id,
                    source_url,
                    str_field(item, "kind").unwrap_or_else(|| "unknown".to_string()),
                    captured_at,
                    raw
                ])
                .map_err(to_string)?;
        }
        Ok(json!({ "received": items.len(), "inserted": inserted, "updated": 0 }))
    }

    pub fn ingest_official_metrics(&self, value: Value) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        conn.execute("DELETE FROM official_metrics", [])
            .map_err(to_string)?;
        let metrics = value
            .get("metrics")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut insert = conn.prepare(
            "INSERT INTO official_metrics (captured_at,label,value,source_url) VALUES (?,?,?,?)"
        ).map_err(to_string)?;
        for metric in &metrics {
            if let (Some(label), Some(metric_value)) =
                (str_field(metric, "label"), str_field(metric, "value"))
            {
                insert
                    .execute(params![
                        str_field(&value, "captured_at").unwrap_or_else(now_iso),
                        label,
                        metric_value,
                        str_field(&value, "source_url").unwrap_or_default()
                    ])
                    .map_err(to_string)?;
            }
        }
        Ok(json!({ "received": metrics.len() }))
    }

    pub fn official_metrics(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        rows_json(
            &conn,
            "SELECT label,value,captured_at,source_url FROM official_metrics ORDER BY id LIMIT 100",
        )
    }

    pub fn ingest_official_sections(&self, value: Value) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let mut upsert = conn
            .prepare(
                "INSERT INTO official_sections (section,period,role,captured_at,raw_json)
            VALUES (?,?,?,?,?) ON CONFLICT(section,period,role) DO UPDATE SET
            captured_at=excluded.captured_at,raw_json=excluded.raw_json",
            )
            .map_err(to_string)?;
        let mut received = 0;
        if let Some(data) = value.get("data").and_then(Value::as_object) {
            for (period, period_data) in data {
                if let Some(global) = period_data.get("global").and_then(Value::as_object) {
                    for (role, values) in global {
                        upsert
                            .execute(params![
                                str_field(&value, "section")
                                    .unwrap_or_else(|| "overview".to_string()),
                                period,
                                role,
                                str_field(&value, "captured_at").unwrap_or_else(now_iso),
                                json_text(values)
                            ])
                            .map_err(to_string)?;
                        received += 1;
                    }
                }
            }
        }
        Ok(json!({ "received": received }))
    }

    pub fn official_sections(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let mut stmt = conn.prepare("SELECT section,period,role,captured_at,raw_json FROM official_sections ORDER BY period,role").map_err(to_string)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(json!({
                    "section": row.get::<_, String>(0)?,
                    "period": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "captured_at": row.get::<_, String>(3)?,
                    "values": parse_json(&row.get::<_, String>(4)?)
                }))
            })
            .map_err(to_string)?;
        collect_rows(rows)
    }

    pub fn ingest_top_character(&self, value: Value) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        conn.execute(
            "INSERT INTO top_character_stats (section,period,role,character,captured_at,raw_json)
            VALUES (?,?,?,?,?,?) ON CONFLICT(section,period,role) DO UPDATE SET
            character=excluded.character,captured_at=excluded.captured_at,raw_json=excluded.raw_json",
            params![
                str_field(&value, "section").unwrap_or_default(),
                str_field(&value, "period").unwrap_or_default(),
                str_field(&value, "role").unwrap_or_default(),
                str_field(&value, "character").unwrap_or_default(),
                str_field(&value, "captured_at").unwrap_or_else(now_iso),
                json_text(value.get("values").unwrap_or(&json!({})))
            ]
        ).map_err(to_string)?;
        Ok(json!({ "received": 1 }))
    }

    pub fn top_characters(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let images = catalog(&conn, "characters")?;
        let mut stmt = conn.prepare("SELECT section,period,role,character,captured_at,raw_json FROM top_character_stats ORDER BY role").map_err(to_string)?;
        let rows = stmt
            .query_map([], |row| {
                let character: String = row.get(3)?;
                Ok(json!({
                    "section": row.get::<_, String>(0)?,
                    "period": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "character": character,
                    "captured_at": row.get::<_, String>(4)?,
                    "image": images.get(&character),
                    "values": parse_json(&row.get::<_, String>(5)?)
                }))
            })
            .map_err(to_string)?;
        collect_rows(rows)
    }

    pub fn matches(&self, limit: i64) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let images = catalogs(&conn)?;
        let mut stmt = conn
            .prepare("SELECT * FROM matches ORDER BY played_at DESC LIMIT ?")
            .map_err(to_string)?;
        let rows = stmt.query_map([limit], |row| {
            let id: String = row.get("id")?;
            let character: Option<String> = row.get("character")?;
            let map: Option<String> = row.get("map")?;
            let loadout = conn.query_row("SELECT * FROM loadouts WHERE match_id=?", [&id], |loadout| {
                Ok(json!({
                    "perks": parse_json(&loadout.get::<_, String>("perks_json")?),
                    "item": loadout.get::<_, Option<String>>("item")?,
                    "addons": parse_json(&loadout.get::<_, String>("addons_json")?),
                    "offering": loadout.get::<_, Option<String>>("offering")?
                }))
            }).optional()?;
            let killer_info = conn.query_row("SELECT * FROM killer_info WHERE match_id=?", [&id], |killer| {
                Ok(json!({
                    "killer": killer.get::<_, Option<String>>("killer")?,
                    "kills_count": killer.get::<_, Option<i64>>("kills_count")?,
                    "perks": parse_json(&killer.get::<_, String>("perks_json")?),
                    "addons": parse_json(&killer.get::<_, String>("addons_json")?),
                    "offering": killer.get::<_, Option<String>>("offering")?
                }))
            }).optional()?;
            let mut participants_stmt = conn.prepare("SELECT * FROM participants WHERE match_id=?")?;
            let participants = participants_stmt.query_map([&id], |p| {
                Ok(json!({
                    "id": p.get::<_, i64>("id")?,
                    "match_id": p.get::<_, String>("match_id")?,
                    "character": p.get::<_, Option<String>>("character")?,
                    "role": p.get::<_, Option<String>>("role")?,
                    "result": p.get::<_, Option<String>>("result")?,
                    "score": p.get::<_, Option<i64>>("score")?,
                    "perks": parse_json(&p.get::<_, String>("perks_json")?),
                    "item": p.get::<_, Option<String>>("item")?,
                    "addons": parse_json(&p.get::<_, String>("addons_json")?),
                    "offering": p.get::<_, Option<String>>("offering")?
                }))
            })?;
            Ok(json!({
                "id": id,
                "source_id": row.get::<_, Option<String>>("source_id")?,
                "played_at": row.get::<_, String>("played_at")?,
                "role": row.get::<_, String>("role")?,
                "character": character,
                "map": map,
                "map_realm": row.get::<_, Option<String>>("map_realm")?,
                "duration_sec": row.get::<_, Option<i64>>("duration_sec")?,
                "result": row.get::<_, Option<String>>("result")?,
                "score": row.get::<_, Option<i64>>("score")?,
                "raw_json": row.get::<_, Option<String>>("raw_json")?,
                "imported_at": row.get::<_, String>("imported_at")?,
                "character_image": character.and_then(|name| images.get("characters").and_then(|m| m.get(&name)).cloned()),
                "map_image": map.and_then(|name| images.get("maps").and_then(|m| m.get(&name)).cloned()),
                "loadout": loadout.unwrap_or_else(|| json!({ "perks": [], "addons": [] })),
                "killer_info": killer_info,
                "participants": collect_rows(participants).unwrap_or_else(|_| json!([]))
            }))
        }).map_err(to_string)?;
        collect_rows(rows)
    }

    pub fn overview(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let mut stmt = conn
            .prepare("SELECT role,result,score,id FROM matches")
            .map_err(to_string)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(to_string)?;
        let mut all = Vec::new();
        for row in rows {
            all.push(row.map_err(to_string)?);
        }
        let survivor_total = all.iter().filter(|r| r.0 == "survivor").count();
        let killer_total = all.iter().filter(|r| r.0 == "killer").count();
        let survivor_escapes = all
            .iter()
            .filter(|r| r.0 == "survivor" && is_escape(r.1.as_deref()))
            .count();
        let mut four_k = 0;
        let mut survivor_wins = 0;
        let mut survivor_draws = 0;
        let mut survivor_losses = 0;
        let mut killer_wins = 0;
        let mut killer_draws = 0;
        let mut killer_losses = 0;
        let scores: Vec<i64> = all.iter().filter_map(|r| r.2).collect();

        for row in &all {
            let kills = kills_for(&conn, &row.3, row.1.as_deref())?;
            if row.0 == "killer" && kills == 4 {
                four_k += 1;
            }
            let escapes = 4 - kills;
            if row.0 == "survivor" {
                if escapes >= 3 {
                    survivor_wins += 1;
                } else if escapes == 2 {
                    survivor_draws += 1;
                } else {
                    survivor_losses += 1;
                }
            } else if row.0 == "killer" {
                if kills >= 3 {
                    killer_wins += 1;
                } else if kills == 2 {
                    killer_draws += 1;
                } else {
                    killer_losses += 1;
                }
            }
        }

        Ok(json!({
            "total_matches": all.len(),
            "survivor_matches": survivor_total,
            "killer_matches": killer_total,
            "survivor_escape_rate": percentage(survivor_escapes, survivor_total),
            "killer_4k_rate": percentage(four_k, killer_total),
            "survivor_winrate": pct_int(survivor_wins, survivor_total),
            "killer_winrate": pct_int(killer_wins, killer_total),
            "survivor_stats": format!("{survivor_wins}V-{survivor_draws}E-{survivor_losses}D"),
            "killer_stats": format!("{killer_wins}V-{killer_draws}E-{killer_losses}D"),
            "average_score": if scores.is_empty() { 0 } else { scores.iter().sum::<i64>() / scores.len() as i64 }
        }))
    }

    pub fn killers(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let images = catalog(&conn, "characters")?;
        let mut stmt = conn
            .prepare(
                "SELECT killer_info.killer, killer_info.kills_count
            FROM killer_info JOIN matches ON matches.id = killer_info.match_id
            WHERE killer_info.killer IS NOT NULL AND matches.role = 'survivor'",
            )
            .map_err(to_string)?;
        grouped_with_winrate(&mut stmt, images, "killer")
    }

    pub fn maps(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let images = catalog(&conn, "maps")?;
        let mut stmt = conn
            .prepare("SELECT map,role,result,map_realm,id FROM matches WHERE map IS NOT NULL")
            .map_err(to_string)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(to_string)?;
        let mut groups: HashMap<String, (usize, usize, Option<String>)> = HashMap::new();
        for row in rows {
            let (name, role, result, realm, id) = row.map_err(to_string)?;
            let kills = kills_for(&conn, &id, result.as_deref())?;
            let won = if role == "survivor" {
                4 - kills >= 3
            } else {
                kills >= 3
            };
            let entry = groups.entry(name).or_insert((0, 0, realm));
            entry.0 += 1;
            if won {
                entry.1 += 1;
            }
        }
        let total: usize = groups.values().map(|v| v.0).sum();
        let mut out: Vec<Value> = groups
            .into_iter()
            .map(|(name, (count, wins, realm))| {
                json!({
                    "map": name,
                    "count": count,
                    "pct": percentage(count, total),
                    "winrate": pct_int(wins, count),
                    "realm": realm,
                    "image": images.get(&name)
                })
            })
            .collect();
        sort_by_count(&mut out);
        Ok(Value::Array(out))
    }

    pub fn perks(&self, scope: &str) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let images = catalog(&conn, "perks")?;
        let sql = match scope {
            "own-survivor" => "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='survivor'",
            "own-killer" => "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='killer'",
            "others-survivor" => "SELECT perks_json FROM participants WHERE role='survivor'",
            "others-killer" => "SELECT k.perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id WHERE m.role='survivor' AND k.perks_json IS NOT NULL",
            "all" => "",
            "own" => "SELECT perks_json FROM loadouts",
            "killer" => "SELECT perks_json FROM killer_info",
            _ => "SELECT perks_json FROM participants",
        };
        let mut rows = Vec::new();
        if scope == "all" {
            rows.extend(string_column(&conn, "SELECT perks_json FROM loadouts")?);
            rows.extend(string_column(&conn, "SELECT perks_json FROM participants")?);
        } else {
            rows.extend(string_column(&conn, sql)?);
        }
        let mut counts: HashMap<String, usize> = HashMap::new();
        for text in &rows {
            if let Some(perks) = parse_json(text).as_array() {
                for perk in perks.iter().filter_map(Value::as_str) {
                    *counts.entry(perk.to_string()).or_default() += 1;
                }
            }
        }
        let mut out: Vec<Value> = counts
            .into_iter()
            .map(|(perk, count)| {
                json!({
                    "perk": perk,
                    "image": images.get(&perk),
                    "count": count,
                    "pct": percentage(count, rows.len())
                })
            })
            .collect();
        sort_by_count(&mut out);
        Ok(Value::Array(out))
    }

    pub fn trends(&self) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        rows_json(&conn, "SELECT substr(played_at,1,10) date, COUNT(*) matches FROM matches GROUP BY date ORDER BY date")
    }

    pub fn asset_images(&self, kind: Option<&str>) -> DbResult<Value> {
        let conn = self.conn.lock().map_err(to_string)?;
        let allowed = [
            "characters",
            "maps",
            "perks",
            "items",
            "addons",
            "offerings",
        ];
        let rows = if let Some(kind) = kind.filter(|k| allowed.contains(k)) {
            let mut stmt = conn
                .prepare("SELECT type,name,url FROM assets WHERE type=?")
                .map_err(to_string)?;
            let rows = collect_asset_rows(stmt.query_map([kind], asset_row).map_err(to_string)?)?;
            rows
        } else {
            let mut stmt = conn
                .prepare("SELECT type,name,url FROM assets")
                .map_err(to_string)?;
            let rows = collect_asset_rows(stmt.query_map([], asset_row).map_err(to_string)?)?;
            rows
        };
        let mut root = Map::new();
        for (kind, name, url) in rows {
            root.entry(kind)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap()
                .insert(name, Value::String(url));
        }
        Ok(Value::Object(root))
    }
}

fn init(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY, source_id TEXT, played_at TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT, map TEXT, map_realm TEXT, duration_sec INTEGER, result TEXT,
          score INTEGER, raw_json TEXT, imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(played_at);
        CREATE INDEX IF NOT EXISTS idx_matches_role ON matches(role);
        CREATE TABLE IF NOT EXISTS loadouts (
          match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
          perks_json TEXT, item TEXT, addons_json TEXT, offering TEXT
        );
        CREATE TABLE IF NOT EXISTS killer_info (
          match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
          killer TEXT, kills_count INTEGER, perks_json TEXT, addons_json TEXT, offering TEXT
        );
        CREATE TABLE IF NOT EXISTS participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT REFERENCES matches(id) ON DELETE CASCADE,
          character TEXT, role TEXT, result TEXT, score INTEGER, perks_json TEXT,
          item TEXT, addons_json TEXT, offering TEXT
        );
        CREATE TABLE IF NOT EXISTS source_snapshots (
          id TEXT PRIMARY KEY, source_url TEXT, kind TEXT, captured_at TEXT, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS official_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL,
          label TEXT NOT NULL, value TEXT NOT NULL, source_url TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS official_sections (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          captured_at TEXT NOT NULL, raw_json TEXT NOT NULL,
          PRIMARY KEY (section, period, role)
        );
        CREATE TABLE IF NOT EXISTS top_character_stats (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT NOT NULL, captured_at TEXT NOT NULL, raw_json TEXT NOT NULL,
          PRIMARY KEY (section, period, role)
        );
        CREATE TABLE IF NOT EXISTS assets (
          type TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
          PRIMARY KEY (type, name)
        );"
    ).map_err(to_string)
}

fn id_for(value: &Value) -> String {
    str_field(value, "id")
        .or_else(|| str_field(value, "source_id"))
        .unwrap_or_else(|| {
            hash(&format!(
                "{}|{}|{}|{}|{}",
                str_field(value, "played_at").unwrap_or_default(),
                str_field(value, "role").unwrap_or_default(),
                str_field(value, "character").unwrap_or_default(),
                str_field(value, "map").unwrap_or_default(),
                int_field(value, "score").unwrap_or_default()
            ))
        })
}

fn index_assets(conn: &Connection, value: &Value) -> DbResult<()> {
    if let (Some(name), Some(path)) = (
        value.get("name").and_then(Value::as_str),
        value.pointer("/image/path").and_then(Value::as_str),
    ) {
        let kind = if path.starts_with("characters/") {
            Some("characters")
        } else if path.starts_with("maps/") {
            Some("maps")
        } else if path.starts_with("perks/") {
            Some("perks")
        } else if path.starts_with("items/") {
            Some("items")
        } else if path.starts_with("add-ons/") {
            Some("addons")
        } else if path.starts_with("offerings/") {
            Some("offerings")
        } else {
            None
        };
        if let Some(kind) = kind {
            conn.execute(
                "INSERT OR REPLACE INTO assets (type,name,url) VALUES (?,?,?)",
                params![kind, name, format!("{ASSET_BASE}{path}")],
            )
            .map_err(to_string)?;
        }
    }
    match value {
        Value::Array(items) => {
            for item in items {
                index_assets(conn, item)?;
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                index_assets(conn, item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn grouped_with_winrate(
    stmt: &mut rusqlite::Statement<'_>,
    images: HashMap<String, String>,
    label: &str,
) -> DbResult<Value> {
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .map_err(to_string)?;
    let mut groups: HashMap<String, (usize, usize)> = HashMap::new();
    for row in rows {
        let (name, kills) = row.map_err(to_string)?;
        let entry = groups.entry(name).or_default();
        entry.0 += 1;
        if 4 - kills.unwrap_or(2) >= 3 {
            entry.1 += 1;
        }
    }
    let total: usize = groups.values().map(|v| v.0).sum();
    let mut out: Vec<Value> = groups
        .into_iter()
        .map(|(name, (count, wins))| {
            json!({
                label: name,
                "count": count,
                "pct": percentage(count, total),
                "winrate": pct_int(wins, count),
                "image": images.get(&name)
            })
        })
        .collect();
    sort_by_count(&mut out);
    Ok(Value::Array(out))
}

fn kills_for(conn: &Connection, match_id: &str, result: Option<&str>) -> DbResult<i64> {
    let direct: Option<i64> = conn
        .query_row(
            "SELECT kills_count FROM killer_info WHERE match_id=?",
            [match_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_string)?;
    if let Some(kills) = direct {
        return Ok(kills);
    }
    let player_escaped = if is_escape(result) { 1 } else { 0 };
    let other_escapes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM participants WHERE match_id=? AND role='survivor' AND
        (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%')",
            [match_id],
            |row| row.get(0),
        )
        .map_err(to_string)?;
    Ok(4 - (player_escaped + other_escapes))
}

fn catalog(conn: &Connection, kind: &str) -> DbResult<HashMap<String, String>> {
    let mut stmt = conn
        .prepare("SELECT name,url FROM assets WHERE type=?")
        .map_err(to_string)?;
    let rows = stmt
        .query_map([kind], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_string)?;
    let mut map = HashMap::new();
    for row in rows {
        let (name, url) = row.map_err(to_string)?;
        map.insert(name, url);
    }
    Ok(map)
}

fn catalogs(conn: &Connection) -> DbResult<HashMap<&'static str, HashMap<String, String>>> {
    let mut result = HashMap::new();
    for kind in [
        "characters",
        "maps",
        "perks",
        "items",
        "addons",
        "offerings",
    ] {
        result.insert(kind, catalog(conn, kind)?);
    }
    Ok(result)
}

fn rows_json(conn: &Connection, sql: &str) -> DbResult<Value> {
    let mut stmt = conn.prepare(sql).map_err(to_string)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map([], |row| {
            let mut map = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = row.get_ref(index)?;
                let json_value = match value {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Real(n) => json!(n),
                    rusqlite::types::ValueRef::Text(text) => {
                        Value::String(String::from_utf8_lossy(text).into_owned())
                    }
                    rusqlite::types::ValueRef::Blob(_) => Value::Null,
                };
                map.insert(name.clone(), json_value);
            }
            Ok(Value::Object(map))
        })
        .map_err(to_string)?;
    collect_rows(rows)
}

fn string_column(conn: &Connection, sql: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(sql).map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(to_string)?);
    }
    Ok(out)
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> DbResult<Value>
where
    T: serde::Serialize,
{
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::to_value(row.map_err(to_string)?).map_err(to_string)?);
    }
    Ok(Value::Array(out))
}

fn asset_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
}

fn collect_asset_rows<F>(
    rows: rusqlite::MappedRows<'_, F>,
) -> DbResult<Vec<(String, String, String)>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String)>,
{
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(to_string)?);
    }
    Ok(out)
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn int_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_f64().map(|n| n as i64))
            .or_else(|| v.as_str()?.parse().ok())
    })
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| json!([]))
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..32].to_string()
}

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn percentage(count: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((count as f64 * 1000.0 / total as f64).round()) / 10.0
    }
}

fn pct_int(count: usize, total: usize) -> i64 {
    if total == 0 {
        0
    } else {
        ((count as f64 * 100.0 / total as f64).round()) as i64
    }
}

fn is_escape(value: Option<&str>) -> bool {
    value
        .map(|v| {
            let v = v.to_ascii_lowercase();
            v.contains("escaped")
                || v.contains("escape")
                || v.contains("fugiu")
                || v.contains("win")
                || v.contains("victory")
        })
        .unwrap_or(false)
}

fn sort_by_count(values: &mut [Value]) {
    values.sort_by(|a, b| {
        b.get("count")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .cmp(&a.get("count").and_then(Value::as_i64).unwrap_or(0))
    });
}

fn to_string(error: impl ToString) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_match_and_calculates_overview() {
        let db = Database::open_memory().unwrap();
        let result = db
            .ingest_matches(json!([{
                "source_id": "one",
                "played_at": "2026-06-08T12:00:00Z",
                "role": "survivor",
                "character": "Meg",
                "map": "Dead Dawg Saloon",
                "result": "escaped",
                "score": 28000,
                "loadout": { "perks": ["Sprint Burst"], "addons": [] },
                "killer_info": { "killer": "The Knight", "kills_count": 2, "perks": ["Nowhere to Hide"], "addons": [] },
                "participants": []
            }]))
            .unwrap();
        assert_eq!(result["inserted"], 1);
        let overview = db.overview().unwrap();
        assert_eq!(overview["total_matches"], 1);
        assert_eq!(overview["survivor_escape_rate"], 100.0);
    }
}
