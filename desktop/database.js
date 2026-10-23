import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  cleanupDuplicatesSqlite(db.db);
  pruneSnapshotsSqlite(db.db);
}

function pruneSnapshotsSqlite(db) {
  try {
    db.exec(`
      DELETE FROM source_snapshots
      WHERE id NOT IN (
        SELECT id FROM source_snapshots
        ORDER BY captured_at DESC
        LIMIT 10
      )
    `);
  } catch {}
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


function indexAssets(db, value) {
  const upsert = db.prepare("INSERT OR REPLACE INTO assets (type,name,url) VALUES (?,?,?)");
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const name = value.name || value.character_name || value.loadout_perk_name || value.character;
    if (name && value.image?.path) {
      const path = value.image.path;
      const type = path.startsWith("characters/") ? "characters" : path.startsWith("maps/") ? "maps" :
        path.startsWith("perks/") ? "perks" : path.startsWith("items/") ? "items" :
        path.startsWith("add-ons/") ? "addons" : path.startsWith("offerings/") ? "offerings" : null;
      if (type) {
        upsert.run(type, name, asset(path));
        if (value.character_id && value.character_id !== name) {
          upsert.run(type, value.character_id, asset(path));
        }
        if (value.loadout_perk_id && value.loadout_perk_id !== name) {
          upsert.run(type, value.loadout_perk_id, asset(path));
        }
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(value);
}


export function openDatabase(path) {
  let localDb = null;
  if (path !== ":memory:") {
    try {
      localDb = new DatabaseSync(path);
      localDb.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-4000; PRAGMA temp_store=FILE; PRAGMA mmap_size=0;");
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
        CREATE INDEX IF NOT EXISTS idx_participants_match_id ON participants(match_id);
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

  // The desktop process must never connect directly to the shared database.
  // A Supabase service-role key in a distributed Electron app is extractable.
  // Community uploads go through the authenticated server-side ingestion API.
  const useRemoteDatabase = false;
  if (path === ":memory:" || !useRemoteDatabase) {
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
        CREATE INDEX IF NOT EXISTS idx_participants_match_id ON participants(match_id);
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
      pruneSnapshotsSqlite(db);
      return { type: "sqlite", db };
    }
    cleanupDuplicatesSqlite(localDb);
    pruneSnapshotsSqlite(localDb);
    return { type: "sqlite", db: localDb };
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
}

export async function ingestSnapshots(db, snapshots) {
  const userEmail = db.userEmail ?? null;
  const insert = db.db.prepare("INSERT OR REPLACE INTO source_snapshots (id,source_url,kind,captured_at,raw_json,user_email) VALUES (?,?,?,?,?,?)");
  let inserted = 0;
  for (const item of snapshots) {
    const raw = JSON.stringify(item.raw);
    const id = createHash("sha256").update(`${item.source_url}|${userEmail ?? ""}`).digest("hex");
    inserted += Number(insert.run(id, item.source_url, item.kind ?? "unknown", item.captured_at, raw, userEmail).changes);
  }
  pruneSnapshotsSqlite(db.db);
  return { received: snapshots.length, inserted, updated: 0 };
}

export async function ingestOfficialMetrics(db, payload) {
  const userEmail = db.userEmail ?? null;
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
}

export async function officialMetrics(db) {
  const userEmail = db.userEmail ?? null;
  const query = userEmail
    ? "SELECT label,value,captured_at,source_url FROM official_metrics WHERE user_email = ? ORDER BY id LIMIT 100"
    : "SELECT label,value,captured_at,source_url FROM official_metrics WHERE user_email IS NULL ORDER BY id LIMIT 100";
  return userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
}

export async function ingestOfficialSections(db, payload) {
  const userEmail = db.userEmail ?? "default";
  const capturedAt = payload.captured_at || new Date().toISOString();
  const section = payload.section ?? "regular-trials";

  if (db.type === "sqlite") {
    const upsert = db.db.prepare(`INSERT INTO official_sections (section,period,role,captured_at,raw_json,user_email)
      VALUES (?,?,?,?,?,?) ON CONFLICT(section,period,role,user_email) DO UPDATE SET
      captured_at=excluded.captured_at,raw_json=excluded.raw_json`);
    const upsertTop = db.db.prepare(`INSERT INTO top_character_stats (section,period,role,character,captured_at,raw_json,user_email)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(section,period,role,user_email) DO UPDATE SET
      character=excluded.character,captured_at=excluded.captured_at,raw_json=excluded.raw_json`);
    let received = 0;
    db.db.exec("BEGIN");
    try {
      if (payload.data) {
        indexAssets(db.db, payload.data);
      }
      for (const [period, periodData] of Object.entries(payload.data ?? {})) {
        if (!periodData) continue;
        if (periodData.global) {
          for (const [role, values] of Object.entries(periodData.global)) {
            upsert.run(section, period, role, capturedAt, JSON.stringify(values), userEmail);
            received++;
          }
        }
        if (periodData.perks) {
          if (Array.isArray(periodData.perks.survivors)) {
            upsert.run(section, period, "perks-survivor", capturedAt, JSON.stringify(periodData.perks.survivors), userEmail);
            received++;
          }
          if (Array.isArray(periodData.perks.killers)) {
            upsert.run(section, period, "perks-killer", capturedAt, JSON.stringify(periodData.perks.killers), userEmail);
            received++;
          }
        }
        if (periodData.characters) {
          if (Array.isArray(periodData.characters.survivors)) {
            upsert.run(section, period, "characters-survivor", capturedAt, JSON.stringify(periodData.characters.survivors), userEmail);
            received++;
          }
          if (Array.isArray(periodData.characters.killers)) {
            upsert.run(section, period, "characters-killer", capturedAt, JSON.stringify(periodData.characters.killers), userEmail);
            received++;
          }
          const killers = Array.isArray(periodData.characters.killers) ? [...periodData.characters.killers] : [];
          killers.sort((a, b) => (b.matches_played || 0) - (a.matches_played || 0) || (b.hours_played_in_match || 0) - (a.hours_played_in_match || 0));
          const topK = killers[0];
          if (topK) {
            const charName = topK.character_name || topK.character_id;
            const values = {
              "Partidas": topK.matches_played,
              "Horas": (Math.round((topK.hours_played_in_match || 0) * 10) / 10) + "h",
              "Taxa de Kill": Math.round((topK.kill_rate || 0) * 100) + "%",
              "Abates": topK.survivors_killed,
              "Ganchos": topK.killer_hooks,
              "Perseguições": topK.killer_chases_won,
              "image": topK.image?.path ? asset(topK.image.path) : undefined
            };
            upsertTop.run(section, period, "killer", charName, capturedAt, JSON.stringify(values), userEmail);
          }

          const survivors = Array.isArray(periodData.characters.survivors) ? [...periodData.characters.survivors] : [];
          survivors.sort((a, b) => (b.matches_played || 0) - (a.matches_played || 0) || (b.hours_played_in_match || 0) - (a.hours_played_in_match || 0));
          const topS = survivors[0];
          if (topS) {
            const charName = topS.character_name || topS.character_id;
            const values = {
              "Partidas": topS.matches_played,
              "Horas": (Math.round((topS.hours_played_in_match || 0) * 10) / 10) + "h",
              "Taxa de Fuga": Math.round((topS.escape_rate || 0) * 100) + "%",
              "Fugas": topS.matches_escaped,
              "Perseguições": topS.survivor_chases_won,
              "Curas": topS.survivor_successfully_healed,
              "image": topS.image?.path ? asset(topS.image.path) : undefined
            };
            upsertTop.run(section, period, "survivor", charName, capturedAt, JSON.stringify(values), userEmail);
          }
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
    if (payload.data) {
      await indexAssetsSupabase(supabase, payload.data);
    }
    for (const [period, periodData] of Object.entries(payload.data ?? {})) {
      if (!periodData) continue;
      if (periodData.global) {
        for (const [role, values] of Object.entries(periodData.global)) {
          await supabase.from("official_sections").upsert({
            section,
            period,
            role,
            captured_at: capturedAt,
            raw_json: values,
            user_email: userEmail
          });
          received++;
        }
      }
      if (periodData.perks) {
        if (Array.isArray(periodData.perks.survivors)) {
          await supabase.from("official_sections").upsert({
            section,
            period,
            role: "perks-survivor",
            captured_at: capturedAt,
            raw_json: periodData.perks.survivors,
            user_email: userEmail
          });
          received++;
        }
        if (Array.isArray(periodData.perks.killers)) {
          await supabase.from("official_sections").upsert({
            section,
            period,
            role: "perks-killer",
            captured_at: capturedAt,
            raw_json: periodData.perks.killers,
            user_email: userEmail
          });
          received++;
        }
      }
      if (periodData.characters) {
        if (Array.isArray(periodData.characters.survivors)) {
          await supabase.from("official_sections").upsert({
            section,
            period,
            role: "characters-survivor",
            captured_at: capturedAt,
            raw_json: periodData.characters.survivors,
            user_email: userEmail
          });
          received++;
        }
        if (Array.isArray(periodData.characters.killers)) {
          await supabase.from("official_sections").upsert({
            section,
            period,
            role: "characters-killer",
            captured_at: capturedAt,
            raw_json: periodData.characters.killers,
            user_email: userEmail
          });
          received++;
        }
        const killers = Array.isArray(periodData.characters.killers) ? [...periodData.characters.killers] : [];
        killers.sort((a, b) => (b.matches_played || 0) - (a.matches_played || 0) || (b.hours_played_in_match || 0) - (a.hours_played_in_match || 0));
        const topK = killers[0];
        if (topK) {
          const charName = topK.character_name || topK.character_id;
          const values = {
            "Partidas": topK.matches_played,
            "Horas": (Math.round((topK.hours_played_in_match || 0) * 10) / 10) + "h",
            "Taxa de Kill": Math.round((topK.kill_rate || 0) * 100) + "%",
            "Abates": topK.survivors_killed,
            "Ganchos": topK.killer_hooks,
            "Perseguições": topK.killer_chases_won,
            "image": topK.image?.path ? asset(topK.image.path) : undefined
          };
          await supabase.from("top_character_stats").upsert({
            section,
            period,
            role: "killer",
            character: charName,
            captured_at: capturedAt,
            raw_json: values,
            user_email: userEmail
          });
        }

        const survivors = Array.isArray(periodData.characters.survivors) ? [...periodData.characters.survivors] : [];
        survivors.sort((a, b) => (b.matches_played || 0) - (a.matches_played || 0) || (b.hours_played_in_match || 0) - (a.hours_played_in_match || 0));
        const topS = survivors[0];
        if (topS) {
          const charName = topS.character_name || topS.character_id;
          const values = {
            "Partidas": topS.matches_played,
            "Horas": (Math.round((topS.hours_played_in_match || 0) * 10) / 10) + "h",
            "Taxa de Fuga": Math.round((topS.escape_rate || 0) * 100) + "%",
            "Fugas": topS.matches_escaped,
            "Perseguições": topS.survivor_chases_won,
            "Curas": topS.survivor_successfully_healed,
            "image": topS.image?.path ? asset(topS.image.path) : undefined
          };
          await supabase.from("top_character_stats").upsert({
            section,
            period,
            role: "survivor",
            character: charName,
            captured_at: capturedAt,
            raw_json: values,
            user_email: userEmail
          });
        }
      }
    }
    return { received };
  }
}

export async function officialSections(db) {
  const userEmail = db.userEmail ?? "default";
  return db.db.prepare(`
    SELECT section,period,role,captured_at,raw_json FROM official_sections
    WHERE user_email = ? AND role IN ('killers','survivors','general')
    ORDER BY period, CASE WHEN section = 'regular-trials' THEN 0 ELSE 1 END, role
  `).all(userEmail)
    .map(row => ({ ...row, values: parse(row.raw_json), raw_json: undefined }));
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
  let rows = [];
  if (db.type === "sqlite") {
    rows = db.db.prepare("SELECT section,period,role,character,captured_at,raw_json FROM top_character_stats WHERE user_email = ? ORDER BY role").all(userEmail)
      .map(row => {
        const values = parse(row.raw_json);
        const img = values.image || images.characters.get(row.character);
        delete values.image;
        return { ...row, image: img, values, raw_json: undefined };
      });
  } else {
    const { data } = check(await db.client
      .from("top_character_stats")
      .select("section,period,role,character,captured_at,raw_json")
      .eq("user_email", userEmail)
      .order("role", { ascending: true }));
    rows = (data || []).map(row => {
      const values = parse(row.raw_json);
      const img = values.image || images.characters.get(row.character);
      delete values.image;
      return {
        ...row,
        image: img,
        values,
        raw_json: undefined
      };
    });
  }

  if (rows.length > 0) return rows;

  // Fallback: deriva os top characters a partir das partidas armazenadas
  if (db.type === "sqlite") {
    const emailFilter = userEmail !== "default" && userEmail ? userEmail : null;
    const query = emailFilter
      ? `SELECT role, character, COUNT(*) as matches_count,
                SUM(CASE WHEN result LIKE '%escape%' OR result LIKE '%fugiu%' OR result LIKE '%win%' OR (role='killer' AND result LIKE '%K' AND CAST(SUBSTR(result,1,1) AS INTEGER) >= 3) THEN 1 ELSE 0 END) as wins_count,
                AVG(score) as avg_bp,
                SUM(score) as total_bp
         FROM matches
         WHERE user_email = ? AND character IS NOT NULL AND character != '?'
         GROUP BY role, character
         ORDER BY matches_count DESC`
      : `SELECT role, character, COUNT(*) as matches_count,
                SUM(CASE WHEN result LIKE '%escape%' OR result LIKE '%fugiu%' OR result LIKE '%win%' OR (role='killer' AND result LIKE '%K' AND CAST(SUBSTR(result,1,1) AS INTEGER) >= 3) THEN 1 ELSE 0 END) as wins_count,
                AVG(score) as avg_bp,
                SUM(score) as total_bp
         FROM matches
         WHERE (user_email IS NULL OR user_email = 'default') AND character IS NOT NULL AND character != '?'
         GROUP BY role, character
         ORDER BY matches_count DESC`;
    const candidates = db.db.prepare(query).all(...(emailFilter ? [emailFilter] : []));
    const byRole = {};
    for (const c of candidates) {
      if (!byRole[c.role]) {
        byRole[c.role] = c;
      }
    }
    const derived = [];
    for (const roleName of ["survivor", "killer"]) {
      const c = byRole[roleName];
      if (c) {
        const rateLabel = roleName === "survivor" ? "Escape Rate" : "Kill Rate";
        const rateVal = percentage(c.wins_count, c.matches_count) + "%";
        derived.push({
          section: "regular-trials",
          period: "all-time",
          role: roleName,
          character: c.character,
          captured_at: new Date().toISOString(),
          image: images.characters.get(c.character),
          values: {
            "Matches played": String(c.matches_count),
            [rateLabel]: rateVal,
            "Total Bloodpoints earned": String(Math.round(c.total_bp || 0)),
            "Average Bloodpoints earned": String(Math.round(c.avg_bp || 0))
          }
        });
      }
    }
    return derived;
  }

  return [];
}

export async function allSavedMatches(db) {
  const userEmail = db.userEmail ?? null;
  if (db.type === "sqlite") {
    const rows = userEmail
      ? db.db.prepare("SELECT * FROM matches WHERE user_email = ? OR user_email IS NULL ORDER BY played_at ASC").all(userEmail)
      : db.db.prepare("SELECT * FROM matches ORDER BY played_at ASC").all();
    const getLoadout = db.db.prepare("SELECT * FROM loadouts WHERE match_id=?");
    const getKiller = db.db.prepare("SELECT * FROM killer_info WHERE match_id=?");
    const getParticipants = db.db.prepare("SELECT * FROM participants WHERE match_id=?");
    return rows.map(match => {
      const loadout = getLoadout.get(match.id);
      const killer = getKiller.get(match.id);
      const participants = getParticipants.all(match.id);
      return {
        ...match,
        loadout: { perks: parse(loadout?.perks_json), item: loadout?.item, addons: parse(loadout?.addons_json), offering: loadout?.offering },
        killer_info: killer ? { killer: killer.killer, kills_count: killer.kills_count, perks: parse(killer.perks_json), addons: parse(killer.addons_json), offering: killer.offering } : null,
        participants: participants.map(p => ({ ...p, perks: parse(p.perks_json), addons: parse(p.addons_json) }))
      };
    });
  }
  return matches(db, 10000);
}

export async function matches(db, limit = 100) {
  const userEmail = db.userEmail ?? null;
  const images = await catalog(db);
  if (db.type === "sqlite") {
    const cols = `m.id, m.source_id, m.played_at, m.role, m.character, m.map, m.map_realm, m.duration_sec, m.result, m.score, m.imported_at, m.user_email,
                  l.perks_json AS l_perks_json, l.item AS l_item, l.addons_json AS l_addons_json, l.offering AS l_offering,
                  k.killer AS k_killer, k.kills_count AS k_kills_count, k.perks_json AS k_perks_json, k.addons_json AS k_addons_json, k.offering AS k_offering`;
    const query = userEmail
      ? `SELECT ${cols}
         FROM matches m
         LEFT JOIN loadouts l ON l.match_id = m.id
         LEFT JOIN killer_info k ON k.match_id = m.id
         WHERE m.user_email = ?
         ORDER BY m.played_at DESC LIMIT ?`
      : `SELECT ${cols}
         FROM matches m
         LEFT JOIN loadouts l ON l.match_id = m.id
         LEFT JOIN killer_info k ON k.match_id = m.id
         WHERE m.user_email IS NULL
         ORDER BY m.played_at DESC LIMIT ?`;
    const getParticipants = db.db.prepare("SELECT * FROM participants WHERE match_id=?");
    return db.db.prepare(query).all(...(userEmail ? [userEmail, limit] : [limit])).map(match => {
      const participants = getParticipants.all(match.id);
      const hasKiller = match.k_killer != null || match.k_kills_count != null || match.k_perks_json != null;
      const result = {
        id: match.id,
        source_id: match.source_id,
        played_at: match.played_at,
        role: match.role,
        character: match.character,
        map: match.map,
        map_realm: match.map_realm,
        duration_sec: match.duration_sec,
        result: match.result,
        score: match.score,
        imported_at: match.imported_at,
        user_email: match.user_email,
        character_image: images.characters.get(match.character),
        map_image: images.maps.get(match.map),
        loadout: { perks: parse(match.l_perks_json), item: match.l_item, addons: parse(match.l_addons_json), offering: match.l_offering },
        killer_info: hasKiller ? { killer: match.k_killer, kills_count: match.k_kills_count, perks: parse(match.k_perks_json), addons: parse(match.k_addons_json), offering: match.k_offering } : null,
        participants: participants.map(p => ({ ...p, character_image: images.characters.get(p.character), perks: parse(p.perks_json), addons: parse(p.addons_json) }))
      };
      return result;
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
  const killerInfoMap = new Map();
  const participantsCountMap = new Map();

  if (rows.length) {
    if (db.type === "sqlite") {
      for (const ki of db.db.prepare("SELECT match_id, kills_count FROM killer_info").all()) {
        killerInfoMap.set(ki.match_id, ki);
      }
      for (const pc of db.db.prepare("SELECT match_id, COUNT(*) AS c FROM participants WHERE role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%') GROUP BY match_id").all()) {
        participantsCountMap.set(pc.match_id, pc.c);
      }
      fourK = killers.filter(row => killerInfoMap.get(row.id)?.kills_count === 4).length;
    } else {
      const matchIds = rows.map(r => r.id);
      const { data: killerInfos } = check(await db.client.from("killer_info").select("match_id, kills_count").in("match_id", matchIds));
      (killerInfos || []).forEach(ki => killerInfoMap.set(ki.match_id, ki));
      fourK = killers.filter(row => killerInfoMap.get(row.id)?.kills_count === 4).length;

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

  const scores = rows.map(row => row.score).filter(Number.isFinite);

  let survWins = 0, survDraws = 0, survLosses = 0;
  let killerWins = 0, killerDraws = 0, killerLosses = 0;

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
      groups.set(name, { count: 0, wins: 0, personalEscapes: 0, totalKills: 0 });
    }
    const g = groups.get(name);
    g.count++;

    const kills = row.kills_count != null ? row.kills_count : 2;
    g.totalKills += kills;
    const escapes = 4 - kills;
    if (escapes >= 3) {
      g.wins++;
    }
    if (/escaped|escape|fugiu|win/i.test(row.result ?? "")) {
      g.personalEscapes++;
    }
  }

  const total = rows.length;

  return [...groups].map(([name, stats]) => {
    const pct = percentage(stats.count, total);
    const winrate = stats.count ? Math.round(stats.wins * 100 / stats.count) : 0;
    const escape_rate = stats.count ? Math.round(stats.personalEscapes * 100 / stats.count) : 0;
    const avg_kills = stats.count ? Math.round((stats.totalKills / stats.count) * 10) / 10 : 0;
    return {
      killer: name,
      count: stats.count,
      pct,
      winrate,
      escape_rate,
      avg_kills,
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
      SELECT m.map, m.role, m.result, m.map_realm, m.character, k.kills_count, k.killer, m.id, m.raw_json
      FROM matches m
      LEFT JOIN killer_info k ON m.id = k.match_id
      WHERE m.map IS NOT NULL AND m.user_email = ?
    `
      : `
      SELECT m.map, m.role, m.result, m.map_realm, m.character, k.kills_count, k.killer, m.id, m.raw_json
      FROM matches m
      LEFT JOIN killer_info k ON m.id = k.match_id
      WHERE m.map IS NOT NULL
    `;
    rows = userEmail ? db.db.prepare(query).all(userEmail) : db.db.prepare(query).all();
  } else {
    let query = db.client
      .from("matches")
      .select("map, role, result, map_realm, character, id, raw_json, killer_info(kills_count, killer)")
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
      character: row.character,
      id: row.id,
      raw_json: row.raw_json,
      kills_count: row.killer_info?.[0]?.kills_count ?? null,
      killer: row.killer_info?.[0]?.killer ?? null
    }));
  }

  const matchIds = rows.map(r => r.id);
  const participantsCountMap = new Map();
  if (matchIds.length) {
    if (db.type === "sqlite") {
      for (const pc of db.db.prepare("SELECT match_id, COUNT(*) AS c FROM participants WHERE role='survivor' AND (result LIKE '%escape%' OR result LIKE '%escaped%' OR result LIKE '%fugiu%') GROUP BY match_id").all()) {
        participantsCountMap.set(pc.match_id, pc.c);
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
    const raw = parse(row.raw_json);
    if (raw?.matchStat?.gameType?.id === "MapShowcase") {
      continue;
    }
    const name = row.map;
    if (!groups.has(name)) {
      groups.set(name, {
        count: 0,
        wins: 0,
        realm: row.map_realm,
        surv_count: 0,
        surv_wins: 0,
        surv_escapes: 0,
        killer_count: 0,
        killer_wins: 0,
        killer_kills: 0,
        killersMap: new Map()
      });
    }
    const g = groups.get(name);
    g.count++;

    const playerEscaped = /escaped|escape|fugiu|win/i.test(row.result ?? "") ? 1 : 0;
    let kills = null;
    if (row.kills_count != null) {
      kills = row.kills_count;
    } else {
      const otherEscapes = participantsCountMap.get(row.id) || 0;
      kills = 4 - (playerEscaped + otherEscapes);
    }

    const escapes = 4 - kills;
    const killerName = row.killer || (row.role === "killer" ? row.character : null);
    if (killerName) {
      g.killersMap.set(killerName, (g.killersMap.get(killerName) || 0) + 1);
    }

    if (row.role === "survivor") {
      g.surv_count++;
      if (escapes >= 3) {
        g.wins++;
        g.surv_wins++;
      }
      if (playerEscaped) {
        g.surv_escapes++;
      }
    } else if (row.role === "killer") {
      g.killer_count++;
      g.killer_kills += kills;
      if (kills >= 3) {
        g.wins++;
        g.killer_wins++;
      }
    }
  }

  let total = 0;
  for (const g of groups.values()) {
    total += g.count;
  }

  return [...groups].map(([name, stats]) => {
    const pct = percentage(stats.count, total);
    const winrate = stats.count ? Math.round(stats.wins * 100 / stats.count) : 0;
    const surv_winrate = stats.surv_count ? Math.round(stats.surv_wins * 100 / stats.surv_count) : null;
    const surv_escape_rate = stats.surv_count ? Math.round(stats.surv_escapes * 100 / stats.surv_count) : null;
    const killer_winrate = stats.killer_count ? Math.round(stats.killer_wins * 100 / stats.killer_count) : null;
    const avg_kills = stats.killer_count ? Math.round((stats.killer_kills / stats.killer_count) * 10) / 10 : null;
    let top_killer = null;
    let topKillerCount = 0;
    for (const [kName, kCount] of stats.killersMap.entries()) {
      if (kCount > topKillerCount) {
        topKillerCount = kCount;
        top_killer = kName;
      }
    }
    return {
      map: name,
      count: stats.count,
      pct,
      winrate,
      surv_count: stats.surv_count,
      surv_winrate,
      surv_escape_rate,
      killer_count: stats.killer_count,
      killer_winrate,
      avg_kills,
      top_killer,
      realm: stats.realm,
      image: images.get(name)
    };
  }).sort((a, b) => b.count - a.count);
}

export async function perks(db, scope = "against", global = false, period = "all-time") {
  const userEmail = global ? null : (db.userEmail ?? null);
  const images = (await catalog(db)).perks;
  const targetPeriod = period === "30-days" ? "30-days" : "all-time";

  if (!global && (scope === "own-survivor" || scope === "own-killer")) {
    const roleTarget = scope === "own-survivor" ? "perks-survivor" : "perks-killer";
    const emailKey = userEmail ?? "default";
    let officialRow = null;
    if (db.type === "sqlite") {
      officialRow = db.db.prepare(
        `SELECT raw_json FROM official_sections 
         WHERE user_email = ? AND role = ? 
         ORDER BY (CASE WHEN period=? THEN 0 WHEN period='all-time' THEN 1 WHEN period='30-days' THEN 2 ELSE 3 END) ASC 
         LIMIT 1`
      ).get(emailKey, roleTarget, targetPeriod);
    } else {
      const { data } = check(await db.client
        .from("official_sections")
        .select("raw_json, period")
        .eq("user_email", emailKey)
        .eq("role", roleTarget)
        .limit(2));
      if (data && data.length) {
        officialRow = data.find(d => d.period === targetPeriod) || data.find(d => d.period === "all-time") || data[0];
      }
    }

    if (officialRow && officialRow.raw_json) {
      const perkList = typeof officialRow.raw_json === "string" ? parse(officialRow.raw_json) : officialRow.raw_json;
      if (Array.isArray(perkList) && perkList.length > 0) {
        return perkList.map(p => {
          const name = p.loadout_perk_name || p.name;
          const img = p.image?.path ? asset(p.image.path) : images.get(name);
          const winrateVal = p.escape_rate != null ? p.escape_rate : p.kill_rate;
          return {
            perk: name,
            image: img,
            count: p.matches_played || 0,
            pct: Math.round((p.pick_rate || 0) * 100),
            winrate: winrateVal != null ? Math.round(winrateVal * 100) : undefined
          };
        }).sort((a, b) => b.count - a.count);
      }
    }
  }

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

export async function characters(db, role = "all", period = "all-time") {
  const userEmail = db.userEmail ?? "default";
  const images = (await catalog(db)).characters;
  const rolesToFetch = role === "survivor" ? ["characters-survivor"] : role === "killer" ? ["characters-killer"] : ["characters-survivor", "characters-killer"];
  const targetPeriod = period === "30-days" ? "30-days" : "all-time";
  let results = [];

  if (db.type === "sqlite") {
    for (const r of rolesToFetch) {
      const row = db.db.prepare(
        `SELECT raw_json FROM official_sections 
         WHERE user_email = ? AND role = ? 
         ORDER BY (CASE WHEN period=? THEN 0 WHEN period='all-time' THEN 1 WHEN period='30-days' THEN 2 ELSE 3 END) ASC 
         LIMIT 1`
      ).get(userEmail, r, targetPeriod);
      if (row && row.raw_json) {
        const list = typeof row.raw_json === "string" ? parse(row.raw_json) : row.raw_json;
        if (Array.isArray(list)) {
          results.push(...list.map(c => {
            const name = c.character_name || c.character_id;
            const img = c.image?.path ? asset(c.image.path) : images.get(name);
            const winrateVal = c.escape_rate != null ? c.escape_rate : c.kill_rate;
            return {
              character: name,
              role: r.replace("characters-", ""),
              image: img,
              count: c.matches_played || 0,
              pct: Math.round((c.pick_rate || 0) * 100),
              winrate: winrateVal != null ? Math.round(winrateVal * 100) : undefined,
              hours: c.hours_played_in_match
            };
          }));
        }
      }
    }
  } else {
    for (const r of rolesToFetch) {
      const { data } = check(await db.client
        .from("official_sections")
        .select("raw_json, period")
        .eq("user_email", userEmail)
        .eq("role", r)
        .limit(2));
      const row = (data || []).find(d => d.period === targetPeriod) || (data || []).find(d => d.period === "all-time") || (data || [])[0];
      if (row && row.raw_json) {
        const list = typeof row.raw_json === "string" ? parse(row.raw_json) : row.raw_json;
        if (Array.isArray(list)) {
          results.push(...list.map(c => {
            const name = c.character_name || c.character_id;
            const img = c.image?.path ? asset(c.image.path) : images.get(name);
            const winrateVal = c.escape_rate != null ? c.escape_rate : c.kill_rate;
            return {
              character: name,
              role: r.replace("characters-", ""),
              image: img,
              count: c.matches_played || 0,
              pct: Math.round((c.pick_rate || 0) * 100),
              winrate: winrateVal != null ? Math.round(winrateVal * 100) : undefined,
              hours: c.hours_played_in_match
            };
          }));
        }
      }
    }
  }

  return results.sort((a, b) => b.count - a.count);
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
