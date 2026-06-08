import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const json = value => JSON.stringify(value ?? []);
const parse = value => {
  try { return JSON.parse(value || "[]"); } catch { return []; }
};
const percentage = (count, total) => total ? Math.round(count * 1000 / total) / 10 : 0;
const ASSET_BASE = "https://assets.live.bhvraccount.com/";
const asset = path => path ? ASSET_BASE + path : undefined;

function catalog(db) {
  const result = { characters: new Map(), maps: new Map(), perks: new Map(), items: new Map(), addons: new Map(), offerings: new Map() };
  for (const row of db.prepare("SELECT type,name,url FROM assets").all()) result[row.type]?.set(row.name, row.url);
  return result;
}

function indexAssets(db, value) {
  const upsert = db.prepare("INSERT OR REPLACE INTO assets (type,name,url) VALUES (?,?,?)");
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (value.name && value.image?.path) {
      const path = value.image.path;
      const type = path.startsWith("characters/") ? "characters" : path.startsWith("maps/") ? "maps" :
        path.startsWith("perks/") ? "perks" : path.startsWith("items/") ? "items" :
        path.startsWith("add-ons/") ? "addons" : path.startsWith("offerings/") ? "offerings" : null;
      if (type) upsert.run(type, value.name, asset(path));
    }
    Object.values(value).forEach(visit);
  };
  visit(value);
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
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
    );
  `);
  return db;
}

function idFor(match) {
  return match.id || match.source_id || createHash("sha256")
    .update(`${match.played_at}|${match.role}|${match.character}|${match.map}|${match.score}`)
    .digest("hex").slice(0, 32);
}

export function ingestMatches(db, matches) {
  const upsert = db.prepare(`INSERT INTO matches
    (id,source_id,played_at,role,character,map,map_realm,duration_sec,result,score,raw_json,imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,played_at=excluded.played_at,
    role=excluded.role,character=excluded.character,map=excluded.map,map_realm=excluded.map_realm,
    duration_sec=excluded.duration_sec,result=excluded.result,score=excluded.score,raw_json=excluded.raw_json`);
  const addLoadout = db.prepare("INSERT INTO loadouts VALUES (?,?,?,?,?)");
  const addKiller = db.prepare("INSERT INTO killer_info VALUES (?,?,?,?,?,?)");
  const addParticipant = db.prepare(`INSERT INTO participants
    (match_id,character,role,result,score,perks_json,item,addons_json,offering) VALUES (?,?,?,?,?,?,?,?,?)`);
  const remove = ["loadouts", "killer_info", "participants"].map(table => db.prepare(`DELETE FROM ${table} WHERE match_id=?`));
  let inserted = 0, updated = 0;
  db.exec("BEGIN");
  try {
    for (const match of matches) {
      const id = idFor(match);
      db.prepare("SELECT id FROM matches WHERE id=?").get(id) ? updated++ : inserted++;
      upsert.run(id, match.source_id ?? null, match.played_at, match.role, match.character ?? null, match.map ?? null,
        match.map_realm ?? null, match.duration_sec ?? null, match.result ?? null, match.score ?? null,
        match.raw == null ? null : JSON.stringify(match.raw), new Date().toISOString());
      if (match.raw) indexAssets(db, match.raw);
      remove.forEach(statement => statement.run(id));
      const loadout = match.loadout ?? {};
      addLoadout.run(id, json(loadout.perks), loadout.item ?? null, json(loadout.addons), loadout.offering ?? null);
      if (match.killer_info) addKiller.run(id, match.killer_info.killer ?? null, match.killer_info.kills_count ?? null,
        json(match.killer_info.perks), json(match.killer_info.addons), match.killer_info.offering ?? null);
      for (const p of match.participants ?? []) addParticipant.run(id, p.character ?? null, p.role, p.result ?? null,
        p.score ?? null, json(p.perks), p.item ?? null, json(p.addons), p.offering ?? null);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { received: matches.length, inserted, updated };
}

export function ingestSnapshots(db, snapshots) {
  const insert = db.prepare("INSERT OR IGNORE INTO source_snapshots VALUES (?,?,?,?,?)");
  let inserted = 0;
  for (const item of snapshots) {
    const raw = JSON.stringify(item.raw);
    const id = createHash("sha256").update(`${item.source_url}|${item.captured_at}|${raw}`).digest("hex");
    inserted += Number(insert.run(id, item.source_url, item.kind ?? "unknown", item.captured_at, raw).changes);
  }
  return { received: snapshots.length, inserted, updated: 0 };
}

export function ingestOfficialMetrics(db, payload) {
  const insert = db.prepare("INSERT INTO official_metrics (captured_at,label,value,source_url) VALUES (?,?,?,?)");
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM official_metrics").run();
    for (const metric of payload.metrics ?? []) {
      if (metric.label && metric.value) insert.run(payload.captured_at, metric.label, metric.value, payload.source_url);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { received: payload.metrics?.length ?? 0 };
}

export function officialMetrics(db) {
  return db.prepare("SELECT label,value,captured_at,source_url FROM official_metrics ORDER BY id LIMIT 100").all();
}

export function ingestOfficialSections(db, payload) {
  const upsert = db.prepare(`INSERT INTO official_sections (section,period,role,captured_at,raw_json)
    VALUES (?,?,?,?,?) ON CONFLICT(section,period,role) DO UPDATE SET
    captured_at=excluded.captured_at,raw_json=excluded.raw_json`);
  let received = 0;
  db.exec("BEGIN");
  try {
    for (const [period, periodData] of Object.entries(payload.data ?? {})) {
      if (!periodData?.global) continue;
      for (const [role, values] of Object.entries(periodData.global)) {
        upsert.run(payload.section ?? "overview", period, role, payload.captured_at, JSON.stringify(values));
        received++;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { received };
}

export function officialSections(db) {
  return db.prepare("SELECT section,period,role,captured_at,raw_json FROM official_sections ORDER BY period,role").all()
    .map(row => ({ ...row, values: parse(row.raw_json), raw_json: undefined }));
}

export function ingestTopCharacter(db, payload) {
  db.prepare(`INSERT INTO top_character_stats (section,period,role,character,captured_at,raw_json)
    VALUES (?,?,?,?,?,?) ON CONFLICT(section,period,role) DO UPDATE SET
    character=excluded.character,captured_at=excluded.captured_at,raw_json=excluded.raw_json`)
    .run(payload.section, payload.period, payload.role, payload.character, payload.captured_at, JSON.stringify(payload.values));
  return { received: 1 };
}

export function topCharacters(db) {
  const images = catalog(db).characters;
  return db.prepare("SELECT section,period,role,character,captured_at,raw_json FROM top_character_stats ORDER BY role").all()
    .map(row => {
      const values = parse(row.raw_json);
      delete values.image;
      return { ...row, image: images.get(row.character), values, raw_json: undefined };
    });
}

export function matches(db, limit = 100) {
  const images = catalog(db);
  return db.prepare("SELECT * FROM matches ORDER BY played_at DESC LIMIT ?").all(limit).map(match => {
    const loadout = db.prepare("SELECT * FROM loadouts WHERE match_id=?").get(match.id);
    const killer = db.prepare("SELECT * FROM killer_info WHERE match_id=?").get(match.id);
    const participants = db.prepare("SELECT * FROM participants WHERE match_id=?").all(match.id);
    return {
      ...match,
      character_image: images.characters.get(match.character),
      map_image: images.maps.get(match.map),
      loadout: { perks: parse(loadout?.perks_json), item: loadout?.item, addons: parse(loadout?.addons_json), offering: loadout?.offering },
      killer_info: killer ? { killer: killer.killer, kills_count: killer.kills_count, perks: parse(killer.perks_json), addons: parse(killer.addons_json), offering: killer.offering } : null,
      participants: participants.map(p => ({ ...p, perks: parse(p.perks_json), addons: parse(p.addons_json) }))
    };
  });
}

export function overview(db) {
  const rows = db.prepare("SELECT role,result,score,id FROM matches").all();
  const survivors = rows.filter(row => row.role === "survivor");
  const killers = rows.filter(row => row.role === "killer");
  const wins = survivors.filter(row => /escaped|escape|fugiu|win|victory/i.test(row.result ?? "")).length;
  const fourK = killers.filter(row => db.prepare("SELECT kills_count FROM killer_info WHERE match_id=?").get(row.id)?.kills_count === 4).length;
  const scores = rows.map(row => row.score).filter(Number.isFinite);

  let survWins = 0, survDraws = 0, survLosses = 0;
  let killerWins = 0, killerDraws = 0, killerLosses = 0;

  for (const row of rows) {
    let kills = null;
    const kInfo = db.prepare("SELECT kills_count FROM killer_info WHERE match_id=?").get(row.id);
    if (kInfo && kInfo.kills_count != null) {
      kills = kInfo.kills_count;
    } else {
      const playerEscaped = /escaped|escape|fugiu|win/i.test(row.result ?? "") ? 1 : 0;
      const otherEscapes = db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id=? AND role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%')").get(row.id)?.c || 0;
      kills = 4 - (playerEscaped + otherEscapes);
    }

    const escapes = 4 - kills;
    if (row.role === "survivor") {
      if (escapes >= 3) survWins++;
      else if (escapes === 2) survDraws++;
      else survLosses++;
    } else if (row.role === "killer") {
      if (kills >= 3) killerWins++;
      else if (kills === 2) killerDraws++;
      else killerLosses++;
    }
  }

  const survTotal = survivors.length;
  const killerTotal = killers.length;

  return {
    total_matches: rows.length, survivor_matches: survTotal, killer_matches: killerTotal,
    survivor_escape_rate: percentage(wins, survTotal), killer_4k_rate: percentage(fourK, killerTotal),
    survivor_winrate: survTotal ? Math.round(survWins * 100 / survTotal) : 0,
    killer_winrate: killerTotal ? Math.round(killerWins * 100 / killerTotal) : 0,
    survivor_stats: `${survWins}V-${survDraws}E-${survLosses}D`,
    killer_stats: `${killerWins}V-${killerDraws}E-${killerLosses}D`,
    average_score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  };
}

function frequency(rows, key, outputKey = key) {
  const counts = new Map();
  rows.filter(row => row[key]).forEach(row => counts.set(row[key], (counts.get(row[key]) ?? 0) + 1));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return [...counts].map(([name, count]) => ({ [outputKey]: name, count, pct: percentage(count, total) })).sort((a, b) => b.count - a.count);
}

export const killers = db => {
  const images = catalog(db).characters;
  const rows = db.prepare(`
    SELECT killer_info.killer, killer_info.kills_count, matches.result
    FROM killer_info
    JOIN matches ON matches.id = killer_info.match_id
    WHERE killer_info.killer IS NOT NULL AND matches.role = 'survivor'
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const name = row.killer;
    if (!groups.has(name)) {
      groups.set(name, { count: 0, wins: 0 });
    }
    const g = groups.get(name);
    g.count++;

    const kills = row.kills_count != null ? row.kills_count : 2;
    const escapes = 4 - kills;
    if (escapes >= 3) {
      g.wins++;
    }
  }

  const total = rows.length;

  return [...groups].map(([name, stats]) => {
    const pct = percentage(stats.count, total);
    const winrate = stats.count ? Math.round(stats.wins * 100 / stats.count) : 0;
    return {
      killer: name,
      count: stats.count,
      pct,
      winrate,
      image: images.get(name)
    };
  }).sort((a, b) => b.count - a.count);
};

export const maps = db => {
  const images = catalog(db).maps;
  const rows = db.prepare(`
    SELECT m.map, m.role, m.result, m.map_realm, k.kills_count, m.id
    FROM matches m
    LEFT JOIN killer_info k ON m.id = k.match_id
    WHERE m.map IS NOT NULL
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const name = row.map;
    if (!groups.has(name)) {
      groups.set(name, { count: 0, wins: 0, realm: row.map_realm });
    }
    const g = groups.get(name);
    g.count++;

    let kills = null;
    if (row.kills_count != null) {
      kills = row.kills_count;
    } else {
      const playerEscaped = /escaped|escape|fugiu|win/i.test(row.result ?? "") ? 1 : 0;
      const otherEscapes = db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id=? AND role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%')").get(row.id)?.c || 0;
      kills = 4 - (playerEscaped + otherEscapes);
    }

    const escapes = 4 - kills;
    if (row.role === "survivor") {
      if (escapes >= 3) g.wins++;
    } else if (row.role === "killer") {
      if (kills >= 3) g.wins++;
    }
  }

  const total = rows.length;

  return [...groups].map(([name, stats]) => {
    const pct = percentage(stats.count, total);
    const winrate = stats.count ? Math.round(stats.wins * 100 / stats.count) : 0;
    return {
      map: name,
      count: stats.count,
      pct,
      winrate,
      realm: stats.realm,
      image: images.get(name)
    };
  }).sort((a, b) => b.count - a.count);
};
export function perks(db, scope = "against") {
  const images = catalog(db).perks;
  let rows;
  if (scope === "own-survivor") {
    rows = db.prepare("SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='survivor'").all();
  } else if (scope === "own-killer") {
    rows = db.prepare("SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='killer'").all();
  } else if (scope === "others-survivor") {
    rows = db.prepare("SELECT perks_json FROM participants WHERE role='survivor'").all();
  } else if (scope === "others-killer") {
    rows = db.prepare("SELECT k.perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id WHERE m.role='survivor' AND k.perks_json IS NOT NULL").all();
  } else if (scope === "all") {
    rows = ["loadouts","participants"].flatMap(t => db.prepare(`SELECT perks_json FROM ${t}`).all());
  } else if (scope === "own") {
    rows = db.prepare("SELECT perks_json FROM loadouts").all();
  } else if (scope === "killer") {
    rows = db.prepare("SELECT perks_json FROM killer_info").all();
  } else {
    rows = db.prepare("SELECT perks_json FROM participants").all();
  }
  const counts = new Map();
  rows.forEach(row => new Set(parse(row.perks_json)).forEach(perk => counts.set(perk, (counts.get(perk) ?? 0) + 1)));
  return [...counts].map(([perk, count]) => ({ perk, image: images.get(perk), count, pct: percentage(count, rows.length) })).sort((a, b) => b.count - a.count);
}

export function trends(db) {
  const rows = db.prepare("SELECT substr(played_at,1,10) date, COUNT(*) matches FROM matches GROUP BY date ORDER BY date").all();
  return rows;
}

export function assetImages(db, type) {
  const types = ["characters","maps","perks","items","addons","offerings"];
  const filter = type && types.includes(type) ? "WHERE type=?" : "";
  const args = filter ? [type] : [];
  const rows = db.prepare(`SELECT type,name,url FROM assets ${filter}`).all(...args);
  const result = {};
  for (const row of rows) {
    if (!result[row.type]) result[row.type] = {};
    result[row.type][row.name] = row.url;
  }
  return result;
}
