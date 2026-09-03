import assert from "node:assert/strict";
import test from "node:test";
import { extractAuthToken, findMatches, normalizeOfficialMatch, formatStatus } from "./background-collector.js";

test("extractAuthToken extrai token de objeto auth-store e valida expiração", () => {
  const validStore = {
    state: {
      authToken: {
        token: "jwt-token-123",
        expirationDate: Date.now() + 3600_000,
        expired: false
      },
      refreshToken: {
        token: "refresh-token-456",
        expirationDate: Date.now() + 86400_000,
        expired: false
      }
    },
    version: 0
  };
  assert.equal(extractAuthToken(validStore), "jwt-token-123");

  // Token expirado
  const expiredStore = {
    state: {
      authToken: {
        token: "jwt-token-expired",
        expirationDate: Date.now() - 1000,
        expired: false
      }
    }
  };
  assert.equal(extractAuthToken(expiredStore), null);

  // Token com expired: true
  const flaggedExpired = {
    state: {
      authToken: {
        token: "jwt-token-flagged",
        expirationDate: Date.now() + 100000,
        expired: true
      }
    }
  };
  assert.equal(extractAuthToken(flaggedExpired), null);

  // Store nulo ou vazio
  assert.equal(extractAuthToken(null), null);
  assert.equal(extractAuthToken({}), null);
});

test("formatStatus normaliza códigos VE_ de status de partida", () => {
  assert.equal(formatStatus({ id: "VE_Escaped", name: "ESCAPED" }), "ESCAPED");
  assert.equal(formatStatus({ id: "VE_Sacrificed", name: "SACRIFICED" }), "SACRIFICED");
  assert.equal(formatStatus({ id: "VE_ManuallyLeftMatch" }), "DISCONNECTED");
  assert.equal(formatStatus({ id: "VE_SurrenderLoss" }), "DEFEAT");
  assert.equal(formatStatus({ id: "VE_Killed", name: "DEAD" }), "DEAD");
});

test("normalizeOfficialMatch normaliza partida oficial fornecida pela API da BHVR", () => {
  const matchPayload = {
    matchStat: {
      gameType: { id: "Online", name: "Online" },
      isCustomMatch: false,
      mapName: "Frm_Silo",
      matchDuration: 640.914,
      matchStartTime: 1788121366,
      specialEventId: "NONE",
      map: {
        id: "Frm_Silo",
        name: "Torment Creek",
        image: { path: "maps/Frm_Silo.png" }
      }
    },
    playerStat: {
      bloodpointsEarned: 0,
      characterLevel: 1,
      characterName: { id: "S54", name: "Aurora Stardotter", image: { path: "characters/survivors/S54.png" } },
      characterLoadout: {
        addOns: [],
        offering: { id: "BloodyPartyStreamers", name: "Bloody Party Streamers", image: { path: "offerings/BloodyPartyStreamers.png" } },
        perks: [
          { id: "S54P03", name: "Boon: Steadfast", image: { path: "perks/S54P03.png" } },
          { id: "Deja_Vu", name: "Deja Vu", image: { path: "perks/Deja_Vu.png" } }
        ],
        power: { id: "Item_Camper_Flashlight", name: "Flashlight", image: { path: "items/Item_Camper_Flashlight.png" } }
      },
      playerRole: "VE_Camper",
      playerStatus: { id: "VE_ManuallyLeftMatch", image: { path: "stats/VE_ManuallyLeftMatch.png" } }
    },
    opponentStat: [
      {
        bloodpointsEarned: 160709,
        playerRole: "VE_Slasher",
        characterName: { id: "K29", name: "The Mastermind", image: { path: "characters/killers/K29.png" } },
        killerMatchStatus: "MERCILESS KILLER",
        characterLoadout: {
          perks: [{ id: "K26P02", name: "Scourge Hook: Pain Resonance", image: { path: "perks/K26P02.png" } }],
          power: { id: "Item_Slasher_K29Power", name: "Virulent Bound", image: { path: "items/Item_Slasher_K29Power.png" } }
        }
      },
      {
        bloodpointsEarned: 73096,
        playerRole: "VE_Camper",
        characterName: { id: "S37", name: "Gabriel Soma", image: { path: "characters/survivors/S37.png" } },
        playerStatus: { id: "VE_Sacrificed", name: "SACRIFICED" },
        characterLoadout: { perks: [] }
      }
    ]
  };

  const normalized = normalizeOfficialMatch(matchPayload);
  assert.ok(normalized);
  assert.equal(normalized.source_id, "official-1788121366");
  assert.equal(normalized.role, "survivor");
  assert.equal(normalized.character, "Aurora Stardotter");
  assert.equal(normalized.map, "Torment Creek");
  assert.equal(normalized.duration_sec, 641);
  assert.equal(normalized.result, "DISCONNECTED");
  assert.equal(normalized.loadout.item, "Flashlight");
  assert.equal(normalized.loadout.offering, "Bloody Party Streamers");
  assert.deepEqual(normalized.loadout.perks, ["Boon: Steadfast", "Deja Vu"]);
  assert.ok(normalized.killer_info);
  assert.equal(normalized.killer_info.killer, "The Mastermind");
  assert.deepEqual(normalized.killer_info.perks, ["Scourge Hook: Pain Resonance"]);

  const matches = findMatches([matchPayload]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].character, "Aurora Stardotter");
});

test("ingestão de payload oficial da API BHVR no banco SQLite", async () => {
  const { openDatabase, ingestMatches, ingestOfficialSections, officialSections, overview } = await import("./database.js");
  const db = openDatabase(":memory:");

  const statsPayload = {
    data: {
      "30-days": {
        global: {
          killers: { totalHoursPlayed: 0.5, totalMatchesPlayed: 3, bpEarnedThroughMatch: 218005 },
          survivors: { totalHoursPlayed: 8, totalMatchesPlayed: 55, bpEarnedThroughMatch: 4814570 },
          general: { totalHoursPlayed: 8.5, totalMatchesPlayed: 58, bpEarnedThroughMatch: 5032575 }
        }
      },
      "all-time": {
        global: {
          killers: { totalHoursPlayed: 48.1, totalMatchesPlayed: 258, bpEarnedThroughMatch: 18306223 },
          survivors: { totalHoursPlayed: 200.6, totalMatchesPlayed: 1231, bpEarnedThroughMatch: 100803706 },
          general: { totalHoursPlayed: 248.7, totalMatchesPlayed: 1489, bpEarnedThroughMatch: 119109929 }
        }
      }
    }
  };

  await ingestOfficialSections(db, { data: statsPayload.data, section: "overview", captured_at: new Date().toISOString() });
  await ingestOfficialSections(db, { data: statsPayload.data, section: "regular-trials", captured_at: new Date().toISOString() });

  const sections = await officialSections(db);
  assert.ok(sections.length >= 6);
  const generalAllTime = sections.find(s => s.section === "regular-trials" && s.period === "all-time" && s.role === "general");
  assert.ok(generalAllTime);
  assert.equal(generalAllTime.values.totalHoursPlayed, 248.7);
  assert.equal(generalAllTime.values.totalMatchesPlayed, 1489);

  const matchPayload = [
    {
      matchStat: {
        gameType: { id: "Online", name: "Online" },
        isCustomMatch: false,
        mapName: "Jnk_Lodge",
        matchDuration: 599.467,
        matchStartTime: 1788120565,
        map: { id: "Jnk_Lodge", name: "Blood Lodge", image: { path: "maps/Jnk_Lodge.png" } }
      },
      playerStat: {
        bloodpointsEarned: 113095,
        characterName: { id: "S54", name: "Aurora Stardotter", image: { path: "characters/survivors/S54.png" } },
        playerRole: "VE_Camper",
        playerStatus: { id: "VE_Escaped", name: "ESCAPED", image: { path: "stats/VE_Escaped.png" } },
        characterLoadout: {
          perks: [{ id: "S54P03", name: "Boon: Steadfast", image: { path: "perks/S54P03.png" } }],
          power: { id: "Item_Camper_CommodiousToolbox", name: "Commodious Toolbox", image: { path: "items/Item_Camper_CommodiousToolbox.png" } }
        }
      },
      opponentStat: [
        {
          bloodpointsEarned: 130838,
          playerRole: "VE_Slasher",
          characterName: { id: "K43", name: "The Slasher", image: { path: "characters/killers/K43.png" } },
          characterLoadout: {
            perks: [{ id: "No_One_Escapes_Death", name: "Hex: No One Escapes Death", image: { path: "perks/No_One_Escapes_Death.png" } }]
          }
        }
      ]
    }
  ];

  const found = findMatches(matchPayload);
  assert.equal(found.length, 1);
  await ingestMatches(db, found);

  const ov = await overview(db);
  assert.equal(ov.total_matches, 1);
  assert.equal(ov.survivor_escape_rate, 100);
});

test("ingestão de payload completo da API BHVR player-stats Regular (characters, perks, global)", async () => {
  const { openDatabase, ingestOfficialSections, officialSections, topCharacters } = await import("./database.js");
  const db = openDatabase(":memory:");

  const bhvrPayload = {
    data: {
      "30-days": {
        characters: {
          killers: [
            {
              character_id: "K30",
              character_name: "The Knight",
              matches_played: 2,
              kill_rate: 0.5,
              hours_played_in_match: 0.4,
              survivors_killed: 4,
              killer_hooks: 9,
              killer_chases_won: 17,
              image: { path: "characters/killers/K30.png" }
            }
          ],
          survivors: [
            {
              character_id: "Nea",
              character_name: "Nea Karlsson",
              matches_played: 30,
              escape_rate: 0.533333,
              matches_escaped: 16,
              hours_played_in_match: 4.6,
              survivor_chases_won: 82,
              survivor_successfully_healed: 117,
              image: { path: "characters/survivors/Nea.png" }
            },
            {
              character_id: "Kate",
              character_name: "Kate Denson",
              matches_played: 3,
              escape_rate: 0.333333,
              matches_escaped: 1,
              hours_played_in_match: 0.4,
              image: { path: "characters/survivors/Kate.png" }
            }
          ]
        },
        perks: {
          survivors: [
            { loadout_perk_id: "Lithe", loadout_perk_name: "Lithe", matches_played: 35, pick_rate: 0.897, image: { path: "perks/Lithe.png" } }
          ],
          killers: [
            { loadout_perk_id: "Hex_Devour_Hope", loadout_perk_name: "Hex: Devour Hope", matches_played: 2, pick_rate: 1, image: { path: "perks/Hex_Devour_Hope.png" } }
          ]
        },
        global: {
          killers: { totalHoursPlayed: 0.4, totalMatchesPlayed: 2, avgKillRate: 0.5, totalKills: 4, totalHooks: 9 },
          survivors: { totalHoursPlayed: 6, totalMatchesPlayed: 39, escapeRate: 0.512821, matchesEscaped: 20 },
          general: { totalHoursPlayed: 6.3, totalMatchesPlayed: 41, bpEarnedThroughMatch: 3931617 }
        }
      }
    }
  };

  await ingestOfficialSections(db, {
    data: bhvrPayload.data,
    section: "regular-trials",
    captured_at: "2026-09-03T12:00:00Z"
  });

  const sections = await officialSections(db);
  assert.equal(sections.length, 3);
  const survGlobal = sections.find(s => s.role === "survivors");
  assert.equal(survGlobal.values.totalMatchesPlayed, 39);
  assert.equal(survGlobal.values.escapeRate, 0.512821);

  const top = await topCharacters(db);
  assert.equal(top.length, 2);
  const topSurv = top.find(t => t.role === "survivor");
  const topKil = top.find(t => t.role === "killer");

  assert.equal(topSurv.character, "Nea Karlsson");
  assert.equal(topSurv.values["Partidas"], 30);
  assert.equal(topSurv.values["Taxa de Fuga"], "53%");
  assert.equal(topSurv.image, "https://assets.live.bhvraccount.com/characters/survivors/Nea.png");

  assert.equal(topKil.character, "The Knight");
  assert.equal(topKil.values["Partidas"], 2);
  assert.equal(topKil.values["Taxa de Kill"], "50%");
  assert.equal(topKil.image, "https://assets.live.bhvraccount.com/characters/killers/K30.png");

  // Assets catalog
  const perkAssets = db.db.prepare("SELECT url FROM assets WHERE name='Lithe'").get();
  assert.equal(perkAssets.url, "https://assets.live.bhvraccount.com/perks/Lithe.png");
});

