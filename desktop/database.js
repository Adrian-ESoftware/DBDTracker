import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@supabase/supabase-js";

const percentage = (count, total) => total ? Math.round(count * 1000 / total) / 10 : 0;
const ASSET_BASE = "https://assets.live.bhvraccount.com/";
const asset = path => path ? ASSET_BASE + path : undefined;

const parse = value => {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
};

const json = (dbType, value) => {
  return dbType === "sqlite" ? JSON.stringify(value ?? []) : (value ?? []);
};

const check = res => {
  if (res.error) {
    throw new Error(`${res.error.message} (details: ${res.error.details || ""}, hint: ${res.error.hint || ""})`);
  }
  return res;
};

function isMoreOrEquallyComplete(incoming, existing) {
  if (!existing) return true;

  let incomingScore = 0;
  if (incoming.map && incoming.map !== "?") incomingScore++;
  if (incoming.duration_sec && incoming.duration_sec > 0) incomingScore++;
  if (incoming.score && incoming.score > 0) incomingScore++;
  if (incoming.killer_info) incomingScore++;
  if (incoming.participants && incoming.participants.length > 1) incomingScore += 2;

  let existingScore = 0;
  if (existing.map && existing.map !== "?") existingScore++;
  if (existing.duration_sec && existing.duration_sec > 0) existingScore++;
  if (existing.score && existing.score > 0) existingScore++;
  
  const existingHasKiller = existing.killer_info || existing.has_killer_info;
  if (existingHasKiller) existingScore++;
  
  const existingPartCount = Array.isArray(existing.participants) ? existing.participants.length : (existing.participants_count || 0);
  if (existingPartCount > 1) existingScore += 2;

  return incomingScore >= existingScore;
}

export function cleanupDuplicates(db) {
  if (db.type === "sqlite") {
    cleanupDuplicatesSqlite(db.db);
  } else {
    cleanupDuplicatesSupabase(db.client);
  }
}

function cleanupDuplicatesSqlite(db) {
  const duplicates = db.prepare(`
    SELECT played_at, role, user_email, COUNT(*) as c
    FROM matches
    GROUP BY played_at, role, user_email
    HAVING c > 1
  `).all();

  if (duplicates.length === 0) return;

  db.exec("BEGIN");
  try {
    for (const dup of duplicates) {
      const query = dup.user_email
        ? "SELECT id, map, duration_sec, score FROM matches WHERE played_at = ? AND role = ? AND user_email = ?"
        : "SELECT id, map, duration_sec, score FROM matches WHERE played_at = ? AND role = ? AND user_email IS NULL";
      const params = dup.user_email ? [dup.played_at, dup.role, dup.user_email] : [dup.played_at, dup.role];
      const rows = db.prepare(query).all(...params);

      const matchesWithInfo = rows.map(row => {
        const pCount = db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id = ?").get(row.id)?.c || 0;
        const hasKiller = db.prepare("SELECT 1 FROM killer_info WHERE match_id = ?").get(row.id) ? 1 : 0;
        return {
          ...row,
          participants_count: pCount,
          has_killer_info: hasKiller
        };
      });

      matchesWithInfo.sort((a, b) => {
        let scoreA = 0;
        if (a.map && a.map !== "?") scoreA++;
        if (a.duration_sec && a.duration_sec > 0) scoreA++;
        if (a.score && a.score > 0) scoreA++;
        if (a.has_killer_info) scoreA++;
        if (a.participants_count > 1) scoreA += 2;

        let scoreB = 0;
        if (b.map && b.map !== "?") scoreB++;
        if (b.duration_sec && b.duration_sec > 0) scoreB++;
        if (b.score && b.score > 0) scoreB++;
        if (b.has_killer_info) scoreB++;
        if (b.participants_count > 1) scoreB += 2;

        return scoreB - scoreA;
      });

      const deleteStmt = db.prepare("DELETE FROM matches WHERE id = ?");
      for (let i = 1; i < matchesWithInfo.length; i++) {
        deleteStmt.run(matchesWithInfo[i].id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("Failed to clean up duplicates:", error);
  }
}

async function cleanupDuplicatesSupabase(supabase) {
  try {
    const { data: matchesList } = check(await supabase
      .from("matches")
      .select("id, played_at, role, map, duration_sec, score, user_email"));
    
    if (!matchesList) return;

    const groups = new Map();
    for (const match of matchesList) {
      const key = `${match.played_at}|${match.role}|${match.user_email || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(match);
    }

    const deleteIds = [];
    for (const [key, rows] of groups.entries()) {
      if (rows.length <= 1) continue;

      const matchIds = rows.map(r => r.id);
      
      const { data: pData } = check(await supabase
        .from("participants")
        .select("match_id")
        .in("match_id", matchIds));

      const { data: kData } = check(await supabase
        .from("killer_info")
        .select("match_id")
        .in("match_id", matchIds));

      const pCounts = {};
      const hasKiller = {};
      matchIds.forEach(id => {
        pCounts[id] = 0;
        hasKiller[id] = false;
      });
      pData?.forEach(p => pCounts[p.match_id] = (pCounts[p.match_id] || 0) + 1);
      kData?.forEach(k => hasKiller[k.match_id] = true);

      const matchesWithInfo = rows.map(row => ({
        ...row,
        participants_count: pCounts[row.id] || 0,
        has_killer_info: hasKiller[row.id] || false
      }));

      matchesWithInfo.sort((a, b) => {
        let scoreA = 0;
        if (a.map && a.map !== "?") scoreA++;
        if (a.duration_sec && a.duration_sec > 0) scoreA++;
        if (a.score && a.score > 0) scoreA++;
        if (a.has_killer_info) scoreA++;
        if (a.participants_count > 1) scoreA += 2;

        let scoreB = 0;
        if (b.map && b.map !== "?") scoreB++;
        if (b.duration_sec && b.duration_sec > 0) scoreB++;
        if (b.score && b.score > 0) scoreB++;
        if (b.has_killer_info) scoreB++;
        if (b.participants_count > 1) scoreB += 2;

        return scoreB - scoreA;
      });

      for (let i = 1; i < matchesWithInfo.length; i++) {
        deleteIds.push(matchesWithInfo[i].id);
      }
    }

    if (deleteIds.length > 0) {
      check(await supabase.from("matches").delete().in("id", deleteIds));
    }
  } catch (err) {
    console.error("Failed to clean up Supabase duplicates:", err);
  }
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

async function indexAssetsSupabase(supabase, value) {
  const visit = async val => {
    if (Array.isArray(val)) {
      for (const item of val) await visit(item);
      return;
    }
    if (!val || typeof val !== "object") return;
    if (val.name && val.image?.path) {
      const path = val.image.path;
      const type = path.startsWith("characters/") ? "characters" : path.startsWith("maps/") ? "maps" :
        path.startsWith("perks/") ? "perks" : path.startsWith("items/") ? "items" :
        path.startsWith("add-ons/") ? "addons" : path.startsWith("offerings/") ? "offerings" : null;
      if (type) {
        check(await supabase.from("assets").upsert({
          type,
          name: val.name,
          url: asset(path)
        }));
      }
    }
    for (const item of Object.values(val)) {
      await visit(item);
    }
  };
  await visit(value);
}

export function openDatabase(path) {
  let localDb = null;
  if (path !== ":memory:") {
    try {
      localDb = new DatabaseSync(path);
      localDb.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      localDb.exec(`
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY, source_id TEXT, played_at TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT, map TEXT, map_realm TEXT, duration_sec INTEGER, result TEXT,
          score INTEGER, raw_json TEXT, imported_at TEXT NOT NULL, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(played_at);
        CREATE INDEX IF NOT EXISTS idx_matches_role ON matches(role);
        CREATE INDEX IF NOT EXISTS idx_matches_user_email ON matches(user_email);
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
          id TEXT PRIMARY KEY, source_url TEXT, kind TEXT, captured_at TEXT, raw_json TEXT, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_user_email ON source_snapshots(user_email);
        CREATE TABLE IF NOT EXISTS official_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL,
          label TEXT NOT NULL, value TEXT NOT NULL, source_url TEXT NOT NULL, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_user_email ON official_metrics(user_email);
        CREATE TABLE IF NOT EXISTS official_sections (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          captured_at TEXT NOT NULL, raw_json TEXT NOT NULL, user_email TEXT NOT NULL DEFAULT 'default',
          PRIMARY KEY (section, period, role, user_email)
        );
        CREATE TABLE IF NOT EXISTS top_character_stats (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT NOT NULL, captured_at TEXT NOT NULL, raw_json TEXT NOT NULL, user_email TEXT NOT NULL DEFAULT 'default',
          PRIMARY KEY (section, period, role, user_email)
        );
        CREATE TABLE IF NOT EXISTS assets (
          type TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
          PRIMARY KEY (type, name)
        );
      `);
    } catch (err) {
      console.error("Failed to initialize local SQLite DB:", err);
    }
  }

  if (path === ":memory:" || !process.env.SUPABASE_URL) {
    if (path === ":memory:") {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS matches (
          id TEXT PRIMARY KEY, source_id TEXT, played_at TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT, map TEXT, map_realm TEXT, duration_sec INTEGER, result TEXT,
          score INTEGER, raw_json TEXT, imported_at TEXT NOT NULL, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(played_at);
        CREATE INDEX IF NOT EXISTS idx_matches_role ON matches(role);
        CREATE INDEX IF NOT EXISTS idx_matches_user_email ON matches(user_email);
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
          id TEXT PRIMARY KEY, source_url TEXT, kind TEXT, captured_at TEXT, raw_json TEXT, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_user_email ON source_snapshots(user_email);
        CREATE TABLE IF NOT EXISTS official_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL,
          label TEXT NOT NULL, value TEXT NOT NULL, source_url TEXT NOT NULL, user_email TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_user_email ON official_metrics(user_email);
        CREATE TABLE IF NOT EXISTS official_sections (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          captured_at TEXT NOT NULL, raw_json TEXT NOT NULL, user_email TEXT NOT NULL DEFAULT 'default',
          PRIMARY KEY (section, period, role, user_email)
        );
        CREATE TABLE IF NOT EXISTS top_character_stats (
          section TEXT NOT NULL, period TEXT NOT NULL, role TEXT NOT NULL,
          character TEXT NOT NULL, captured_at TEXT NOT NULL, raw_json TEXT NOT NULL, user_email TEXT NOT NULL DEFAULT 'default',
          PRIMARY KEY (section, period, role, user_email)
        );
        CREATE TABLE IF NOT EXISTS assets (
          type TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
          PRIMARY KEY (type, name)
        );
      `);
      cleanupDuplicatesSqlite(db);
      return { type: "sqlite", db };
    }
    cleanupDuplicatesSqlite(localDb);
    return { type: "sqlite", db: localDb };
  } else {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    cleanupDuplicatesSupabase(supabase);
    return { type: "supabase", client: supabase };
  }
}

function idFor(match, userEmail) {
  const baseId = match.id || match.source_id || createHash("sha256")
    .update(`${match.played_at}|${match.role}|${match.character}|${match.map}|${match.score}`)
    .digest("hex").slice(0, 32);
  if (userEmail) {
    const prefix = userEmail.replace(/[^a-zA-Z0-9]/g, "_");
    if (!baseId.startsWith(`${prefix}_`)) {
      return `${prefix}_${baseId}`;
    }
  }
  return baseId;
}

export async function ingestMatches(db, matches) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const upsert = db.db.prepare(`INSERT INTO matches
      (id,source_id,played_at,role,character,map,map_realm,duration_sec,result,score,raw_json,imported_at,user_email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,played_at=excluded.played_at,
      role=excluded.role,character=excluded.character,map=excluded.map,map_realm=excluded.map_realm,
      duration_sec=excluded.duration_sec,result=excluded.result,score=excluded.score,raw_json=excluded.raw_json,user_email=excluded.user_email`);
    const addLoadout = db.db.prepare("INSERT INTO loadouts VALUES (?,?,?,?,?)");
    const addKiller = db.db.prepare("INSERT INTO killer_info VALUES (?,?,?,?,?,?)");
    const addParticipant = db.db.prepare(`INSERT INTO participants
      (match_id,character,role,result,score,perks_json,item,addons_json,offering) VALUES (?,?,?,?,?,?,?,?,?)`);
    const remove = ["loadouts", "killer_info", "participants"].map(table => db.db.prepare(`DELETE FROM ${table} WHERE match_id=?`));
    let inserted = 0, updated = 0;
    db.db.exec("BEGIN");
    try {
      for (const match of matches) {
        if (!match.played_at || !match.role) continue;

        const existing = db.db.prepare("SELECT id, map, duration_sec, score FROM matches WHERE played_at = ? AND role = ? AND (user_email = ? OR (? IS NULL AND user_email IS NULL))").get(match.played_at, match.role, userEmail, userEmail);

        let id;
        if (existing) {
          const pCount = db.db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id = ?").get(existing.id)?.c || 0;
          const hasKiller = db.db.prepare("SELECT 1 FROM killer_info WHERE match_id = ?").get(existing.id) ? 1 : 0;
          existing.participants_count = pCount;
          existing.has_killer_info = hasKiller;

          if (!isMoreOrEquallyComplete(match, existing)) {
            continue;
          }
          id = existing.id;
          updated++;
        } else {
          id = idFor(match, userEmail);
          inserted++;
        }

        upsert.run(id, match.source_id ?? null, match.played_at, match.role, match.character ?? null, match.map ?? null,
          match.map_realm ?? null, match.duration_sec ?? null, match.result ?? null, match.score ?? null,
          match.raw == null ? null : JSON.stringify(match.raw), new Date().toISOString(), userEmail);
        if (match.raw) indexAssets(db.db, match.raw);
        remove.forEach(statement => statement.run(id));
        const loadout = match.loadout ?? {};
        addLoadout.run(id, json("sqlite", loadout.perks), loadout.item ?? null, json("sqlite", loadout.addons), loadout.offering ?? null);
        if (match.killer_info) addKiller.run(id, match.killer_info.killer ?? null, match.killer_info.kills_count ?? null,
          json("sqlite", match.killer_info.perks), json("sqlite", match.killer_info.addons), match.killer_info.offering ?? null);
        for (const p of match.participants ?? []) addParticipant.run(id, p.character ?? null, p.role, p.result ?? null,
          p.score ?? null, json("sqlite", p.perks), p.item ?? null, json("sqlite", p.addons), p.offering ?? null);
      }
      db.db.exec("COMMIT");
    } catch (error) {
      db.db.exec("ROLLBACK");
      throw error;
    }
    return { received: matches.length, inserted, updated };
  } else {
    const supabase = db.client;
    let inserted = 0, updated = 0;

    for (const match of matches) {
      if (!match.played_at || !match.role) continue;

      let query = supabase
        .from("matches")
        .select("id, map, duration_sec, score")
        .eq("played_at", match.played_at)
        .eq("role", match.role);
      if (userEmail) {
        query = query.eq("user_email", userEmail);
      } else {
        query = query.is("user_email", null);
      }
      const { data: existingList } = check(await query);

      const existing = existingList?.[0];

      let id;
      if (existing) {
        const { count: pCount } = check(await supabase
          .from("participants")
          .select("*", { count: "exact", head: true })
          .eq("match_id", existing.id));

        const { data: kData } = check(await supabase
          .from("killer_info")
          .select("match_id")
          .eq("match_id", existing.id));

        existing.participants_count = pCount || 0;
        existing.has_killer_info = !!kData?.length;

        if (!isMoreOrEquallyComplete(match, existing)) {
          continue;
        }
        id = existing.id;
        updated++;
      } else {
        id = idFor(match, userEmail);
        inserted++;
      }

      check(await supabase.from("matches").upsert({
        id,
        source_id: match.source_id ?? null,
        played_at: match.played_at,
        role: match.role,
        character: match.character ?? null,
        map: match.map ?? null,
        map_realm: match.map_realm ?? null,
        duration_sec: match.duration_sec ?? null,
        result: match.result ?? null,
        score: match.score ?? null,
        raw_json: match.raw ?? null,
        imported_at: new Date().toISOString(),
        user_email: userEmail
      }));

      if (match.raw) {
        await indexAssetsSupabase(supabase, match.raw);
      }

      check(await supabase.from("loadouts").delete().eq("match_id", id));
      check(await supabase.from("killer_info").delete().eq("match_id", id));
      check(await supabase.from("participants").delete().eq("match_id", id));

      const loadout = match.loadout ?? {};
      check(await supabase.from("loadouts").insert({
        match_id: id,
        perks_json: loadout.perks || [],
        item: loadout.item ?? null,
        addons_json: loadout.addons || [],
        offering: loadout.offering ?? null
      }));

      if (match.killer_info) {
        check(await supabase.from("killer_info").insert({
          match_id: id,
          killer: match.killer_info.killer ?? null,
          kills_count: match.killer_info.kills_count ?? null,
          perks_json: match.killer_info.perks || [],
          addons_json: match.killer_info.addons || [],
          offering: match.killer_info.offering ?? null
        }));
      }

      if (match.participants?.length) {
        const partsToInsert = match.participants.map(p => ({
          match_id: id,
          character: p.character ?? null,
          role: p.role,
          result: p.result ?? null,
          score: p.score ?? null,
          perks_json: p.perks || [],
          item: p.item ?? null,
          addons_json: p.addons || [],
          offering: p.offering ?? null
        }));
        check(await supabase.from("participants").insert(partsToInsert));
      }
    }

    return { received: matches.length, inserted, updated };
  }
}

export async function ingestSnapshots(db, snapshots) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const insert = db.db.prepare("INSERT OR IGNORE INTO source_snapshots (id,source_url,kind,captured_at,raw_json,user_email) VALUES (?,?,?,?,?,?)");
    let inserted = 0;
    for (const item of snapshots) {
      const raw = JSON.stringify(item.raw);
      const id = createHash("sha256").update(`${item.source_url}|${item.captured_at}|${raw}`).digest("hex");
      inserted += Number(insert.run(id, item.source_url, item.kind ?? "unknown", item.captured_at, raw, userEmail).changes);
    }
    return { received: snapshots.length, inserted, updated: 0 };
  } else {
    const supabase = db.client;
    let inserted = 0;
    for (const item of snapshots) {
      const id = createHash("sha256").update(`${item.source_url}|${item.captured_at}|${JSON.stringify(item.raw)}`).digest("hex");
      const { error } = await supabase.from("source_snapshots").insert({
        id,
        source_url: item.source_url,
        kind: item.kind ?? "unknown",
        captured_at: item.captured_at,
        raw_json: item.raw,
        user_email: userEmail
      });
      if (!error) inserted++;
    }
    return { received: snapshots.length, inserted, updated: 0 };
  }
}

export async function ingestOfficialMetrics(db, payload) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const insert = db.db.prepare("INSERT INTO official_metrics (captured_at,label,value,source_url,user_email) VALUES (?,?,?,?,?)");
    db.db.exec("BEGIN");
    try {
      if (userEmail) {
        db.db.prepare("DELETE FROM official_metrics WHERE user_email = ?").run(userEmail);
      } else {
        db.db.prepare("DELETE FROM official_metrics WHERE user_email IS NULL").run();
      }
      for (const metric of payload.metrics ?? []) {
        if (metric.label && metric.value) insert.run(payload.captured_at, metric.label, metric.value, payload.source_url, userEmail);
      }
      db.db.exec("COMMIT");
    } catch (error) {
      db.db.exec("ROLLBACK");
      throw error;
    }
    return { received: payload.metrics?.length ?? 0 };
  } else {
    const supabase = db.client;
    let deleteQuery = supabase.from("official_metrics").delete();
    if (userEmail) {
      deleteQuery = deleteQuery.eq("user_email", userEmail);
    } else {
      deleteQuery = deleteQuery.is("user_email", null);
    }
    check(await deleteQuery);
    const metricsToInsert = (payload.metrics ?? [])
      .filter(m => m.label && m.value)
      .map(m => ({
        captured_at: payload.captured_at,
        label: m.label,
        value: m.value,
        source_url: payload.source_url,
        user_email: userEmail
      }));
    if (metricsToInsert.length) {
      await supabase.from("official_metrics").insert(metricsToInsert);
    }
    return { received: payload.metrics?.length ?? 0 };
  }
}

export async function officialMetrics(db) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const query = userEmail
      ? "SELECT label,value,captured_at,source_url FROM official_metrics WHERE user_email = ? ORDER BY id LIMIT 100"
      : "SELECT label,value,captured_at,source_url FROM official_metrics WHERE user_email IS NULL ORDER BY id LIMIT 100";
    return userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client
      .from("official_metrics")
      .select("label,value,captured_at,source_url")
      .order("id", { ascending: true })
      .limit(100);
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    } else {
      query = query.is("user_email", null);
    }
    const { data } = check(await query);
    return data || [];
  }
}

export async function ingestOfficialSections(db, payload) {
  const userEmail = db.userEmail ?? "default";
  if (db.type === "sqlite") {
    const upsert = db.db.prepare(`INSERT INTO official_sections (section,period,role,captured_at,raw_json,user_email)
      VALUES (?,?,?,?,?,?) ON CONFLICT(section,period,role,user_email) DO UPDATE SET
      captured_at=excluded.captured_at,raw_json=excluded.raw_json`);
    let received = 0;
    db.db.exec("BEGIN");
    try {
      for (const [period, periodData] of Object.entries(payload.data ?? {})) {
        if (!periodData?.global) continue;
        for (const [role, values] of Object.entries(periodData.global)) {
          upsert.run(payload.section ?? "overview", period, role, payload.captured_at, JSON.stringify(values), userEmail);
          received++;
        }
      }
      db.db.exec("COMMIT");
    } catch (error) {
      db.db.exec("ROLLBACK");
      throw error;
    }
    return { received };
  } else {
    const supabase = db.client;
    let received = 0;
    for (const [period, periodData] of Object.entries(payload.data ?? {})) {
      if (!periodData?.global) continue;
      for (const [role, values] of Object.entries(periodData.global)) {
        await supabase.from("official_sections").upsert({
          section: payload.section ?? "overview",
          period,
          role,
          captured_at: payload.captured_at,
          raw_json: values,
          user_email: userEmail
        });
        received++;
      }
    }
    return { received };
  }
}

export async function officialSections(db) {
  const userEmail = db.userEmail ?? "default";
  if (db.type === "sqlite") {
    return db.db.prepare("SELECT section,period,role,captured_at,raw_json FROM official_sections WHERE user_email = ? ORDER BY period,role").all(userEmail)
      .map(row => ({ ...row, values: parse(row.raw_json), raw_json: undefined }));
  } else {
    const { data } = check(await db.client
      .from("official_sections")
      .select("section,period,role,captured_at,raw_json")
      .eq("user_email", userEmail)
      .order("period", { ascending: true })
      .order("role", { ascending: true }));
    return (data || []).map(row => ({
      ...row,
      values: parse(row.raw_json),
      raw_json: undefined
    }));
  }
}

export async function ingestTopCharacter(db, payload) {
  const userEmail = db.userEmail ?? "default";
  if (db.type === "sqlite") {
    db.db.prepare(`INSERT INTO top_character_stats (section,period,role,character,captured_at,raw_json,user_email)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(section,period,role,user_email) DO UPDATE SET
      character=excluded.character,captured_at=excluded.captured_at,raw_json=excluded.raw_json`)
      .run(payload.section, payload.period, payload.role, payload.character, payload.captured_at, JSON.stringify(payload.values), userEmail);
    return { received: 1 };
  } else {
    const supabase = db.client;
    await supabase.from("top_character_stats").upsert({
      section: payload.section,
      period: payload.period,
      role: payload.role,
      character: payload.character,
      captured_at: payload.captured_at,
      raw_json: payload.values,
      user_email: userEmail
    });
    return { received: 1 };
  }
}

async function catalog(db) {
  const result = { characters: new Map(), maps: new Map(), perks: new Map(), items: new Map(), addons: new Map(), offerings: new Map() };
  if (db.type === "sqlite") {
    for (const row of db.db.prepare("SELECT type,name,url FROM assets").all()) result[row.type]?.set(row.name, row.url);
  } else {
    const { data } = check(await db.client.from("assets").select("type,name,url"));
    (data || []).forEach(row => result[row.type]?.set(row.name, row.url));
  }
  return result;
}

export async function topCharacters(db) {
  const userEmail = db.userEmail ?? "default";
  const images = await catalog(db);
  if (db.type === "sqlite") {
    return db.db.prepare("SELECT section,period,role,character,captured_at,raw_json FROM top_character_stats WHERE user_email = ? ORDER BY role").all(userEmail)
      .map(row => {
        const values = parse(row.raw_json);
        delete values.image;
        return { ...row, image: images.characters.get(row.character), values, raw_json: undefined };
      });
  } else {
    const { data } = check(await db.client
      .from("top_character_stats")
      .select("section,period,role,character,captured_at,raw_json")
      .eq("user_email", userEmail)
      .order("role", { ascending: true }));
    return (data || []).map(row => {
      const values = parse(row.raw_json);
      delete values.image;
      return {
        ...row,
        image: images.characters.get(row.character),
        values,
        raw_json: undefined
      };
    });
  }
}

export async function matches(db, limit = 100) {
  const userEmail = db.userEmail ?? null;
  const images = await catalog(db);
  if (db.type === "sqlite") {
    const query = userEmail
      ? "SELECT * FROM matches WHERE user_email = ? ORDER BY played_at DESC LIMIT ?"
      : "SELECT * FROM matches WHERE user_email IS NULL ORDER BY played_at DESC LIMIT ?";
    return db.db.prepare(query).all(...(userEmail ? [userEmail, limit] : [limit])).map(match => {
      const loadout = db.db.prepare("SELECT * FROM loadouts WHERE match_id=?").get(match.id);
      const killer = db.db.prepare("SELECT * FROM killer_info WHERE match_id=?").get(match.id);
      const participants = db.db.prepare("SELECT * FROM participants WHERE match_id=?").all(match.id);
      return {
        ...match,
        character_image: images.characters.get(match.character),
        map_image: images.maps.get(match.map),
        loadout: { perks: parse(loadout?.perks_json), item: loadout?.item, addons: parse(loadout?.addons_json), offering: loadout?.offering },
        killer_info: killer ? { killer: killer.killer, kills_count: killer.kills_count, perks: parse(killer.perks_json), addons: parse(killer.addons_json), offering: killer.offering } : null,
        participants: participants.map(p => ({ ...p, perks: parse(p.perks_json), addons: parse(p.addons_json) }))
      };
    });
  } else {
    let query = db.client.from("matches").select("*");
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    } else {
      query = query.is("user_email", null);
    }
    const { data: matchesData } = check(await query.order("played_at", { ascending: false }).limit(limit));

    if (!matchesData?.length) return [];

    const matchIds = matchesData.map(m => m.id);

    const { data: loadouts } = check(await db.client.from("loadouts").select("*").in("match_id", matchIds));
    const { data: killers } = check(await db.client.from("killer_info").select("*").in("match_id", matchIds));
    const { data: participants } = check(await db.client.from("participants").select("*").in("match_id", matchIds));

    const loadoutsMap = new Map((loadouts || []).map(l => [l.match_id, l]));
    const killersMap = new Map((killers || []).map(k => [k.match_id, k]));
    
    const participantsMap = new Map();
    (participants || []).forEach(p => {
      if (!participantsMap.has(p.match_id)) participantsMap.set(p.match_id, []);
      participantsMap.get(p.match_id).push(p);
    });

    return matchesData.map(match => {
      const loadout = loadoutsMap.get(match.id);
      const killer = killersMap.get(match.id);
      const parts = participantsMap.get(match.id) || [];
      return {
        ...match,
        character_image: images.characters.get(match.character),
        map_image: images.maps.get(match.map),
        loadout: {
          perks: parse(loadout?.perks_json),
          item: loadout?.item,
          addons: parse(loadout?.addons_json),
          offering: loadout?.offering
        },
        killer_info: killer ? {
          killer: killer.killer,
          kills_count: killer.kills_count,
          perks: parse(killer.perks_json),
          addons: parse(killer.addons_json),
          offering: killer.offering
        } : null,
        participants: parts.map(p => ({
          ...p,
          perks: parse(p.perks_json),
          addons: parse(p.addons_json)
        }))
      };
    });
  }
}

export async function overview(db) {
  const userEmail = db.userEmail ?? null;
  let rows;
  if (db.type === "sqlite") {
    const query = userEmail
      ? "SELECT role,result,score,id FROM matches WHERE user_email = ?"
      : "SELECT role,result,score,id FROM matches WHERE user_email IS NULL";
    rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client.from("matches").select("role,result,score,id");
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    } else {
      query = query.is("user_email", null);
    }
    const { data } = check(await query);
    rows = data || [];
  }

  const survivors = rows.filter(row => row.role === "survivor");
  const killers = rows.filter(row => row.role === "killer");
  const wins = survivors.filter(row => /escaped|escape|fugiu|win|victory/i.test(row.result ?? "")).length;
  
  let fourK = 0;
  if (db.type === "sqlite") {
    fourK = killers.filter(row => db.db.prepare("SELECT kills_count FROM killer_info WHERE match_id=?").get(row.id)?.kills_count === 4).length;
  } else {
    const killerIds = killers.map(k => k.id);
    if (killerIds.length) {
      const { data: killerInfos } = check(await db.client.from("killer_info").select("match_id, kills_count").in("match_id", killerIds));
      const killerInfoMap = new Map((killerInfos || []).map(ki => [ki.match_id, ki]));
      fourK = killers.filter(row => killerInfoMap.get(row.id)?.kills_count === 4).length;
    }
  }

  const scores = rows.map(row => row.score).filter(Number.isFinite);

  let survWins = 0, survDraws = 0, survLosses = 0;
  let killerWins = 0, killerDraws = 0, killerLosses = 0;

  const matchIds = rows.map(r => r.id);
  const killerInfoMap = new Map();
  const participantsCountMap = new Map();

  if (matchIds.length) {
    if (db.type === "sqlite") {
      for (const row of rows) {
        const kInfo = db.db.prepare("SELECT kills_count FROM killer_info WHERE match_id=?").get(row.id);
        if (kInfo) killerInfoMap.set(row.id, kInfo);
        const pCount = db.db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id=? AND role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%')").get(row.id)?.c || 0;
        participantsCountMap.set(row.id, pCount);
      }
    } else {
      const { data: killerInfos } = check(await db.client.from("killer_info").select("match_id, kills_count").in("match_id", matchIds));
      (killerInfos || []).forEach(ki => killerInfoMap.set(ki.match_id, ki));

      const { data: escapedParticipants } = check(await db.client
        .from("participants")
        .select("match_id")
        .eq("role", "survivor")
        .or("result.ilike.%escape%,result.ilike.%escaped%,result.ilike.%fugiu%")
        .in("match_id", matchIds));

      (escapedParticipants || []).forEach(ep => {
        participantsCountMap.set(ep.match_id, (participantsCountMap.get(ep.match_id) || 0) + 1);
      });
    }
  }

  for (const row of rows) {
    let kills = null;
    const kInfo = killerInfoMap.get(row.id);
    if (kInfo && kInfo.kills_count != null) {
      kills = kInfo.kills_count;
    } else {
      const playerEscaped = /escaped|escape|fugiu|win/i.test(row.result ?? "") ? 1 : 0;
      const otherEscapes = participantsCountMap.get(row.id) || 0;
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

export async function killers(db, global = false) {
  const userEmail = global ? null : (db.userEmail ?? null);
  const images = (await catalog(db)).characters;
  let rows;
  if (db.type === "sqlite") {
    const query = userEmail
      ? `
      SELECT killer_info.killer, killer_info.kills_count, matches.result
      FROM killer_info
      JOIN matches ON matches.id = killer_info.match_id
      WHERE killer_info.killer IS NOT NULL AND matches.role = 'survivor' AND matches.user_email = ?
    `
      : `
      SELECT killer_info.killer, killer_info.kills_count, matches.result
      FROM killer_info
      JOIN matches ON matches.id = killer_info.match_id
      WHERE killer_info.killer IS NOT NULL AND matches.role = 'survivor'
    `;
    rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client
      .from("killer_info")
      .select("killer, kills_count, matches!inner(result, role, user_email)")
      .eq("matches.role", "survivor")
      .not("killer", "is", null);
    if (userEmail) {
      query = query.eq("matches.user_email", userEmail);
    }
    const { data } = check(await query);
    rows = (data || []).map(row => ({
      killer: row.killer,
      kills_count: row.kills_count,
      result: row.matches.result
    }));
  }

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
}

export async function maps(db, global = false) {
  const userEmail = global ? null : (db.userEmail ?? null);
  const images = (await catalog(db)).maps;
  let rows;
  if (db.type === "sqlite") {
    const query = userEmail
      ? `
      SELECT m.map, m.role, m.result, m.map_realm, k.kills_count, m.id
      FROM matches m
      LEFT JOIN killer_info k ON m.id = k.match_id
      WHERE m.map IS NOT NULL AND m.user_email = ?
    `
      : `
      SELECT m.map, m.role, m.result, m.map_realm, k.kills_count, m.id
      FROM matches m
      LEFT JOIN killer_info k ON m.id = k.match_id
      WHERE m.map IS NOT NULL
    `;
    rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client
      .from("matches")
      .select("map, role, result, map_realm, id, killer_info(kills_count)")
      .not("map", "is", null);
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    }
    const { data } = check(await query);
    rows = (data || []).map(row => ({
      map: row.map,
      role: row.role,
      result: row.result,
      map_realm: row.map_realm,
      id: row.id,
      kills_count: row.killer_info?.[0]?.kills_count ?? null
    }));
  }

  const matchIds = rows.map(r => r.id);
  const participantsCountMap = new Map();
  if (matchIds.length) {
    if (db.type === "sqlite") {
      for (const row of rows) {
        const pCount = db.db.prepare("SELECT COUNT(*) c FROM participants WHERE match_id=? AND role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%')").get(row.id)?.c || 0;
        participantsCountMap.set(row.id, pCount);
      }
    } else {
      const { data: escapedParticipants } = check(await db.client
        .from("participants")
        .select("match_id")
        .eq("role", "survivor")
        .or("result.ilike.%escape%,result.ilike.%escaped%,result.ilike.%fugiu%")
        .in("match_id", matchIds));

      (escapedParticipants || []).forEach(ep => {
        participantsCountMap.set(ep.match_id, (participantsCountMap.get(ep.match_id) || 0) + 1);
      });
    }
  }

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
      const otherEscapes = participantsCountMap.get(row.id) || 0;
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
}

export async function perks(db, scope = "against", global = false) {
  const userEmail = global ? null : (db.userEmail ?? null);
  const images = (await catalog(db)).perks;
  let rows = [];
  if (db.type === "sqlite") {
    if (scope === "own-survivor") {
      const query = userEmail
        ? "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='survivor' AND m.user_email = ?"
        : "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='survivor'";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else if (scope === "own-killer") {
      const query = userEmail
        ? "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='killer' AND m.user_email = ?"
        : "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.role='killer'";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else if (scope === "others-survivor") {
      const query = userEmail
        ? "SELECT p.perks_json FROM participants p JOIN matches m ON p.match_id=m.id WHERE p.role='survivor' AND m.user_email = ?"
        : "SELECT p.perks_json FROM participants p JOIN matches m ON p.match_id=m.id WHERE p.role='survivor'";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else if (scope === "others-killer") {
      const query = userEmail
        ? "SELECT k.perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id WHERE m.role='survivor' AND k.perks_json IS NOT NULL AND m.user_email = ?"
        : "SELECT k.perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id WHERE m.role='survivor' AND k.perks_json IS NOT NULL";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else if (scope === "all") {
      const q1 = userEmail
        ? "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.user_email = ?"
        : "SELECT l.perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id";
      const q2 = userEmail
        ? "SELECT p.perks_json FROM participants p JOIN matches m ON p.match_id=m.id WHERE m.user_email = ?"
        : "SELECT p.perks_json FROM participants p JOIN matches m ON p.match_id=m.id";
      rows = [
        ...(userEmail ? db.db.prepare(q1).all(userEmail) : db.db.prepare(q1).all()),
        ...(userEmail ? db.db.prepare(q2).all(userEmail) : db.db.prepare(q2).all())
      ];
    } else if (scope === "own") {
      const query = userEmail
        ? "SELECT perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id WHERE m.user_email = ?"
        : "SELECT perks_json FROM loadouts l JOIN matches m ON l.match_id=m.id";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else if (scope === "killer") {
      const query = userEmail
        ? "SELECT perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id WHERE m.user_email = ?"
        : "SELECT perks_json FROM killer_info k JOIN matches m ON k.match_id=m.id";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    } else {
      const query = userEmail
        ? "SELECT perks_json FROM participants p JOIN matches m ON p.match_id=m.id WHERE m.user_email = ?"
        : "SELECT perks_json FROM participants p JOIN matches m ON p.match_id=m.id";
      rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
    }
  } else {
    if (scope === "own-survivor") {
      let query = db.client.from("loadouts").select("perks_json, matches!inner(role, user_email)").eq("matches.role", "survivor");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else if (scope === "own-killer") {
      let query = db.client.from("loadouts").select("perks_json, matches!inner(role, user_email)").eq("matches.role", "killer");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else if (scope === "others-survivor") {
      let query = db.client.from("participants").select("perks_json, matches!inner(user_email)").eq("role", "survivor");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else if (scope === "others-killer") {
      let query = db.client.from("killer_info").select("perks_json, matches!inner(role, user_email)").eq("matches.role", "survivor").not("perks_json", "is", null);
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else if (scope === "all") {
      let q1 = db.client.from("loadouts").select("perks_json, matches!inner(user_email)");
      if (userEmail) q1 = q1.eq("matches.user_email", userEmail);
      const { data: lData } = check(await q1);

      let q2 = db.client.from("participants").select("perks_json, matches!inner(user_email)");
      if (userEmail) q2 = q2.eq("matches.user_email", userEmail);
      const { data: pData } = check(await q2);

      rows = [...(lData || []), ...(pData || [])];
    } else if (scope === "own") {
      let query = db.client.from("loadouts").select("perks_json, matches!inner(user_email)");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else if (scope === "killer") {
      let query = db.client.from("killer_info").select("perks_json, matches!inner(user_email)");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    } else {
      let query = db.client.from("participants").select("perks_json, matches!inner(user_email)");
      if (userEmail) query = query.eq("matches.user_email", userEmail);
      const { data } = check(await query);
      rows = data || [];
    }
  }
  const counts = new Map();
  rows.forEach(row => new Set(parse(row.perks_json)).forEach(perk => counts.set(perk, (counts.get(perk) ?? 0) + 1)));
  return [...counts].map(([perk, count]) => ({ perk, image: images.get(perk), count, pct: percentage(count, rows.length) })).sort((a, b) => b.count - a.count);
}

export async function trends(db) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const query = userEmail
      ? "SELECT substr(played_at,1,10) date, COUNT(*) matches FROM matches WHERE user_email = ? GROUP BY date ORDER BY date"
      : "SELECT substr(played_at,1,10) date, COUNT(*) matches FROM matches WHERE user_email IS NULL GROUP BY date ORDER BY date";
    return userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client.from("matches").select("played_at");
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    } else {
      query = query.is("user_email", null);
    }
    const { data } = check(await query);
    const counts = {};
    (data || []).forEach(row => {
      const date = row.played_at.slice(0, 10);
      counts[date] = (counts[date] || 0) + 1;
    });
    return Object.entries(counts).map(([date, matches]) => ({ date, matches })).sort((a, b) => a.date.localeCompare(b.date));
  }
}

export async function assetImages(db, type) {
  const types = ["characters","maps","perks","items","addons","offerings"];
  const filter = type && types.includes(type) ? "WHERE type=?" : "";
  const args = filter ? [type] : [];
  
  let rows;
  if (db.type === "sqlite") {
    rows = db.db.prepare(`SELECT type,name,url FROM assets ${filter}`).all(...args);
  } else {
    let query = db.client.from("assets").select("type,name,url");
    if (type && types.includes(type)) {
      query = query.eq("type", type);
    }
    const { data } = check(await query);
    rows = data || [];
  }

  const result = {};
  for (const row of rows) {
    if (!result[row.type]) result[row.type] = {};
    result[row.type][row.name] = row.url;
  }
  return result;
}

export async function getBackfillSnapshots(db) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const query = userEmail
      ? `SELECT source_url,raw_json FROM source_snapshots
         WHERE (source_url LIKE '%/player-stats/games/dbd/providers/%'
            OR source_url LIKE '%/player-stats/match-history/games/dbd/providers/%')
           AND user_email = ?
         ORDER BY captured_at DESC LIMIT 10`
      : `SELECT source_url,raw_json FROM source_snapshots
         WHERE (source_url LIKE '%/player-stats/games/dbd/providers/%'
            OR source_url LIKE '%/player-stats/match-history/games/dbd/providers/%')
           AND user_email IS NULL
         ORDER BY captured_at DESC LIMIT 10`;
    const stmt = db.db.prepare(query);
    return (userEmail ? stmt.all(userEmail) : stmt.all()).map(row => ({
      source_url: row.source_url,
      raw_json: parse(row.raw_json)
    }));
  } else {
    let query = db.client
      .from("source_snapshots")
      .select("source_url, raw_json")
      .or("source_url.ilike.%/player-stats/games/dbd/providers/%,source_url.ilike.%/player-stats/match-history/games/dbd/providers/%");
    
    if (userEmail) {
      query = query.eq("user_email", userEmail);
    } else {
      query = query.is("user_email", null);
    }
    
    const { data } = check(await query.order("captured_at", { ascending: false }).limit(10));
    
    return (data || []).map(row => ({
      source_url: row.source_url,
      raw_json: parse(row.raw_json)
    }));
  }
}
