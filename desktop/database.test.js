import assert from "node:assert/strict";
import test from "node:test";
import { ingestOfficialMetrics, ingestOfficialSections, ingestTopCharacter, openDatabase, ingestMatches, killers, maps, matches, officialMetrics, officialSections, overview, perks, topCharacters } from "./database.js";

test("grava partidas e calcula métricas no SQLite", () => {
  const db = openDatabase(":memory:");
  const result = ingestMatches(db, [{
    source_id: "one", played_at: "2026-06-08T12:00:00Z", role: "survivor", character: "Meg",
    map: "Dead Dawg Saloon", result: "escaped", score: 28000,
    loadout: { perks: ["Sprint Burst"], addons: [] },
    killer_info: { killer: "The Knight", kills_count: 2, perks: ["Nowhere to Hide"], addons: [] },
    participants: [{ role: "killer", character: "The Knight", perks: ["Nowhere to Hide"], addons: [] }],
    raw: {
      matchStat: { map: { name: "Dead Dawg Saloon", image: { path: "maps/Ukraine.png" } } },
      playerStat: { characterName: { name: "Meg", image: { path: "characters/survivors/Meg.png" } }, characterLoadout: { perks: [{ name: "Sprint Burst", image: { path: "perks/Sprint_Burst.png" } }] } },
      opponentStat: [{ characterName: { name: "The Knight", image: { path: "characters/killers/K30.png" } }, characterLoadout: { perks: [{ name: "Nowhere to Hide", image: { path: "perks/NowhereToHide.png" } }] } }]
    }
  }]);
  assert.equal(result.inserted, 1);
  assert.equal(overview(db).survivor_escape_rate, 100);
  assert.equal(killers(db)[0].killer, "The Knight");
  assert.equal(maps(db)[0].map, "Dead Dawg Saloon");
  assert.equal(perks(db)[0].perk, "Nowhere to Hide");
  assert.equal(matches(db)[0].loadout.perks[0], "Sprint Burst");
  assert.match(matches(db)[0].character_image, /assets\.live\.bhvraccount\.com/);
  assert.match(killers(db)[0].image, /characters\/killers/);
  assert.match(maps(db)[0].image, /maps\//);
  assert.match(perks(db, "all")[0].image, /perks\//);
  ingestMatches(db, [{
    source_id: "two", played_at: "2026-06-08T13:00:00Z", role: "survivor", character: "Kate",
    map: "Ormond", result: "escaped", score: 30000, loadout: { perks: [], addons: [] }, participants: []
  }]);
  assert.equal(matches(db).length, 2, "partidas antigas devem permanecer quando uma nova janela do site for importada");
  ingestOfficialMetrics(db, {
    captured_at: "2026-06-08T12:00:00Z",
    source_url: "https://stats.deadbydaylight.com/statistics/",
    metrics: [{ label: "Escapes", value: "123" }]
  });
  assert.equal(officialMetrics(db)[0].value, "123");
  ingestOfficialSections(db, { section: "regular-trials", captured_at: "2026-06-08T12:00:00Z", data: { "all-time": { global: { killers: { totalKills: 12 }, survivors: { matchesEscaped: 8 }, general: { totalMatchesPlayed: 20 } } } } });
  assert.equal(officialSections(db).length, 3);
  ingestTopCharacter(db, { section: "regular-trials", period: "all-time", role: "survivor", character: "Kate Denson", captured_at: "2026-06-08T12:00:00Z", values: { "Matches played": "95" } });
  assert.equal(topCharacters(db)[0].character, "Kate Denson");
});
