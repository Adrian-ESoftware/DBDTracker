import assert from "node:assert/strict";
import test from "node:test";
import { ingestOfficialMetrics, ingestOfficialSections, ingestTopCharacter, openDatabase, ingestMatches, killers, maps, matches, officialMetrics, officialSections, overview, perks, topCharacters } from "./database.js";

test("grava partidas e calcula métricas no SQLite", async () => {
  const db = openDatabase(":memory:");
  const result = await ingestMatches(db, [{
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
  assert.equal((await overview(db)).survivor_escape_rate, 100);
  assert.equal((await killers(db))[0].killer, "The Knight");
  assert.equal((await maps(db))[0].map, "Dead Dawg Saloon");
  assert.equal((await perks(db))[0].perk, "Nowhere to Hide");
  assert.equal((await matches(db))[0].loadout.perks[0], "Sprint Burst");
  assert.match((await matches(db))[0].character_image, /assets\.live\.bhvraccount\.com/);
  assert.match((await killers(db))[0].image, /characters\/killers/);
  assert.match((await maps(db))[0].image, /maps\//);
  assert.match((await perks(db, "all"))[0].image, /perks\//);
  
  await ingestMatches(db, [{
    source_id: "two", played_at: "2026-06-08T13:00:00Z", role: "survivor", character: "Kate",
    map: "Ormond", result: "escaped", score: 30000, loadout: { perks: [], addons: [] }, participants: []
  }]);
  assert.equal((await matches(db)).length, 2, "partidas antigas devem permanecer quando uma nova janela do site for importada");
  
  await ingestOfficialMetrics(db, {
    captured_at: "2026-06-08T12:00:00Z",
    source_url: "https://stats.deadbydaylight.com/statistics/",
    metrics: [{ label: "Escapes", value: "123" }]
  });
  assert.equal((await officialMetrics(db))[0].value, "123");
  
  await ingestOfficialSections(db, { section: "regular-trials", captured_at: "2026-06-08T12:00:00Z", data: { "all-time": { global: { killers: { totalKills: 12 }, survivors: { matchesEscaped: 8 }, general: { totalMatchesPlayed: 20 } } } } });
  assert.equal((await officialSections(db)).length, 3);
  
  await ingestTopCharacter(db, { section: "regular-trials", period: "all-time", role: "survivor", character: "Kate Denson", captured_at: "2026-06-08T12:00:00Z", values: { "Matches played": "95" } });
  assert.equal((await topCharacters(db))[0].character, "Kate Denson");
});

test("limpa duplicatas e evita ingestão de dados incompletos", async () => {
  const db = openDatabase(":memory:");

  // Ingest complete match
  await ingestMatches(db, [{
    source_id: "id-complete", played_at: "2026-06-08T18:13:00Z", role: "survivor", character: "Kate",
    map: "Mother's Dwelling", result: "escaped", score: 19773,
    loadout: { perks: ["Sprint Burst"] },
    killer_info: { killer: "The Knight", kills_count: 3 },
    participants: [{ character: "Lee Yun-jin", role: "survivor", result: "dead", score: 18646 }]
  }]);

  // Ingest incomplete duplicate (same played_at and role)
  await ingestMatches(db, [{
    source_id: "id-incomplete", played_at: "2026-06-08T18:13:00Z", role: "survivor", character: "Kate",
    map: null, result: "escaped", score: 19773,
    loadout: { perks: ["Sprint Burst"] },
    participants: [{ character: "Lee Yun-jin", role: "survivor", result: "dead", score: 18646 }]
  }]);

  const list = await matches(db);
  // Should only have 1 match
  assert.equal(list.length, 1);
  // It must be the complete one (has map name)
  assert.equal(list[0].map, "Mother's Dwelling");
  // Killer info must be preserved
  assert.ok(list[0].killer_info);
  assert.equal(list[0].killer_info.killer, "The Knight");

  // Now let's try the reverse order: insert incomplete first, then complete
  const db2 = openDatabase(":memory:");
  await ingestMatches(db2, [{
    source_id: "id-incomplete", played_at: "2026-06-08T18:13:00Z", role: "survivor", character: "Kate",
    map: null, result: "escaped", score: 19773,
    loadout: { perks: ["Sprint Burst"] },
    participants: [{ character: "Lee Yun-jin", role: "survivor", result: "dead", score: 18646 }]
  }]);

  await ingestMatches(db2, [{
    source_id: "id-complete", played_at: "2026-06-08T18:13:00Z", role: "survivor", character: "Kate",
    map: "Mother's Dwelling", result: "escaped", score: 19773,
    loadout: { perks: ["Sprint Burst"] },
    killer_info: { killer: "The Knight", kills_count: 3 },
    participants: [{ character: "Lee Yun-jin", role: "survivor", result: "dead", score: 18646 }]
  }]);

  const list2 = await matches(db2);
  assert.equal(list2.length, 1);
  // Should have been upgraded to the complete one
  assert.equal(list2[0].map, "Mother's Dwelling");
  assert.ok(list2[0].killer_info);
});

test("isolamento multi-usuário (multi-tenancy) no SQLite", async () => {
  const db = openDatabase(":memory:");

  // Usuário A
  db.userEmail = "userA@test.com";
  await ingestMatches(db, [{
    source_id: "match-A1", played_at: "2026-06-08T12:00:00Z", role: "survivor", character: "Meg",
    map: "Dead Dawg Saloon", result: "escaped", score: 25000,
    loadout: { perks: ["Sprint Burst"] }
  }]);

  // Usuário B
  db.userEmail = "userB@test.com";
  await ingestMatches(db, [{
    source_id: "match-B1", played_at: "2026-06-08T13:00:00Z", role: "survivor", character: "Dwight",
    map: "Ormond", result: "escaped", score: 30000,
    loadout: { perks: ["Prove Thyself"] }
  }]);

  // Verificar dados do Usuário A
  db.userEmail = "userA@test.com";
  const matchesA = await matches(db);
  assert.equal(matchesA.length, 1);
  assert.equal(matchesA[0].character, "Meg");
  assert.equal((await overview(db)).total_matches, 1);
  assert.equal((await maps(db))[0].map, "Dead Dawg Saloon");
  assert.equal((await perks(db, "own"))[0].perk, "Sprint Burst");

  // Verificar dados do Usuário B
  db.userEmail = "userB@test.com";
  const matchesB = await matches(db);
  assert.equal(matchesB.length, 1);
  assert.equal(matchesB[0].character, "Dwight");
  assert.equal((await overview(db)).total_matches, 1);
  assert.equal((await maps(db))[0].map, "Ormond");
  assert.equal((await perks(db, "own"))[0].perk, "Prove Thyself");

  // Verificar que os IDs gerados têm prefixos diferentes no banco sqlite bruto
  db.userEmail = null;
  const rawMatches = db.db.prepare("SELECT id, user_email FROM matches").all();
  assert.equal(rawMatches.length, 2);
  assert.ok(rawMatches.find(m => m.user_email === "userA@test.com").id.startsWith("userA_test_com_"));
  assert.ok(rawMatches.find(m => m.user_email === "userB@test.com").id.startsWith("userB_test_com_"));
});

