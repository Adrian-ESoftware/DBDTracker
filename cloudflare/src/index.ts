export interface Env {
  DB: D1Database;
  ADMIN_KEY?: string;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

async function sha256Hex(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

const cleanText = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

const cleanNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter(item => typeof item === "string" && item.trim())
        .map(item => item.trim().slice(0, 160))
        .slice(0, 8)
    : [];

const cleanParticipants = (value: unknown) =>
  Array.isArray(value)
    ? value.slice(0, 5).map((player: any) => ({
        character_id: cleanText(player?.character_id ?? player?.character),
        role: ["survivor", "killer"].includes(player?.role) ? player.role : null,
        result: cleanText(player?.result),
        perks: cleanNames(player?.perks)
      }))
    : [];

const AUTH_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min cache em memória para reduzir leituras em community_accounts
const authCache = new Map<string, { account: { id: string; email: string | null }; expiresAt: number }>();

const SUBMISSION_CACHE_TTL_MS = 30 * 60 * 1000;
const recentSubmissionsCache = new Map<string, number>();

const BACKUP_SUMMARY_CACHE_TTL_MS = 15 * 60 * 1000;
const backupSummaryCache = new Map<
  string,
  { total_matches: number; last_match_at: string | null; expiresAt: number }
>();

let schemaMigratedInIsolate = false;

/**
 * Migração preguiçosa e idempotente para bancos D1 já existentes:
 * - Cria `community_meta` para snapshots de 1 linha (stats e resumo de backup)
 * - Adiciona `loadout_json` e `participants_json` inline em `community_matches` (reduzindo 7 escritas/partida para 1)
 * - Remove 4 índices redundantes/inúteis que custavam escritas extras em cada INSERT
 * - Cria índices enxutos para busca por (owner_id, played_at) e LOWER(email)
 */
export async function ensureSchemaMigrated(db: D1Database, force = false): Promise<void> {
  if (schemaMigratedInIsolate && !force) return;
  try {
    if (!force) {
      const meta = await db
        .prepare("SELECT value_json FROM community_meta WHERE key = 'schema_version'")
        .first<{ value_json: string }>();
      if (meta?.value_json === "2") {
        schemaMigratedInIsolate = true;
        return;
      }
    }
  } catch {
    // community_meta ainda não existe; prossegue com a migração única
  }

  const ddlStatements = [
    "CREATE TABLE IF NOT EXISTS community_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    "ALTER TABLE community_matches ADD COLUMN loadout_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE community_matches ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]'",
    "CREATE INDEX IF NOT EXISTS idx_comm_matches_owner_played ON community_matches(owner_id, played_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_accounts_email_lower ON community_accounts(LOWER(email))",
    "DROP INDEX IF EXISTS idx_accounts_token_hash",
    "DROP INDEX IF EXISTS idx_submissions_owner_hash",
    "DROP INDEX IF EXISTS idx_comm_matches_played",
    "DROP INDEX IF EXISTS idx_comm_matches_query",
    "UPDATE community_submissions SET payload_json = '{}' WHERE LENGTH(payload_json) > 2",
    "INSERT INTO community_meta (key, value_json, updated_at) VALUES ('schema_version', '2', unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json = '2', updated_at = unixepoch()"
  ];

  for (const sql of ddlStatements) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Ignora erro caso coluna já exista
    }
  }
  schemaMigratedInIsolate = true;
}

function invalidateAccountAuthCache(accountId: string) {
  for (const [key, entry] of authCache.entries()) {
    if (entry.account.id === accountId) {
      authCache.delete(key);
    }
  }
}

async function authenticate(
  request: Request,
  env: Env
): Promise<{ id: string; email: string | null } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const cached = authCache.get(tokenHash);
  if (cached && cached.expiresAt > now) {
    return cached.account;
  }

  const account = await env.DB.prepare(
    "SELECT id, email FROM community_accounts WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<{ id: string; email: string | null }>();

  if (account) {
    authCache.set(tokenHash, { account, expiresAt: now + AUTH_CACHE_TTL_MS });
  }

  return account ?? null;
}

let lastStatsRefreshTime = 0;
const STATS_REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 min cooldown
let cachedStatsResponse: { data: any; timestamp: number } | null = null;
const STATS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min cache em memória no Worker

/**
 * Constrói declarações SQL incrementais (UPSERT) para atualizar `public_*_stats`
 * apenas com as partidas novas inseridas no lote atual, evitando varrer `community_matches`!
 */
function buildIncrementalStatStatements(db: D1Database, newMatches: any[]): D1PreparedStatement[] {
  if (newMatches.length === 0) return [];

  const charDeltas = new Map<
    string,
    {
      patch: string;
      role: string;
      character_id: string;
      match_count: number;
      escapes: number;
      kills: number;
      scoreSum: number;
      scoreCount: number;
    }
  >();
  const mapDeltas = new Map<
    string,
    { patch: string; role: string; map_id: string; match_count: number; escapes: number; kills: number }
  >();
  const killerDeltas = new Map<
    string,
    { patch: string; killer_id: string; match_count: number; kills: number }
  >();
  const perkDeltas = new Map<
    string,
    { patch: string; role: string; perk_id: string; usage_count: number }
  >();

  const addChar = (
    patch: string,
    role: string,
    character_id: string | null,
    escapes: number,
    kills: number,
    score: number | null
  ) => {
    if (!character_id) return;
    const key = `${patch}|${role}|${character_id}`;
    const prev = charDeltas.get(key) || {
      patch,
      role,
      character_id,
      match_count: 0,
      escapes: 0,
      kills: 0,
      scoreSum: 0,
      scoreCount: 0
    };
    prev.match_count += 1;
    prev.escapes += escapes;
    prev.kills += kills;
    if (typeof score === "number" && Number.isFinite(score)) {
      prev.scoreSum += score;
      prev.scoreCount += 1;
    }
    charDeltas.set(key, prev);
  };

  const addPerk = (patch: string, role: string, perk_id: string | null) => {
    if (!perk_id || (role !== "survivor" && role !== "killer")) return;
    const key = `${patch}|${role}|${perk_id}`;
    const prev = perkDeltas.get(key) || { patch, role, perk_id, usage_count: 0 };
    prev.usage_count += 1;
    perkDeltas.set(key, prev);
  };

  for (const m of newMatches) {
    const patch = m.patch_version || "unknown";
    const isEscaped = m.role === "survivor" && /escape/i.test(m.result || "") ? 1 : 0;
    const matchKills = m.kills_count ?? 0;

    // 1. Personagem principal do jogador
    if (m.character_id) {
      addChar(
        patch,
        m.role,
        m.character_id,
        isEscaped,
        m.role === "killer" ? matchKills : 0,
        m.score
      );
    }

    // 2. Killer enfrentado quando o jogador é survivor
    if (m.role === "survivor" && m.killer_id) {
      addChar(patch, "killer", m.killer_id, 0, matchKills, null);
    }

    // 3. Participantes
    const participants = Array.isArray(m.participants) ? m.participants : [];
    for (const p of participants) {
      if (!p?.character_id || (p.role !== "survivor" && p.role !== "killer")) continue;
      if (m.role === "survivor" && p.role === "killer" && m.killer_id) continue;
      const pEscaped = p.role === "survivor" && /escape/i.test(p.result || "") ? 1 : 0;
      addChar(patch, p.role, p.character_id, pEscaped, 0, null);
    }

    // 4. Mapa
    if (m.map_id) {
      const mapKey = `${patch}|${m.role}|${m.map_id}`;
      const prevMap = mapDeltas.get(mapKey) || {
        patch,
        role: m.role,
        map_id: m.map_id,
        match_count: 0,
        escapes: 0,
        kills: 0
      };
      prevMap.match_count += 1;
      prevMap.escapes += isEscaped;
      prevMap.kills += m.role === "killer" ? matchKills : 0;
      mapDeltas.set(mapKey, prevMap);
    }

    // 5. Killer stats
    const effectiveKiller = m.killer_id || (m.role === "killer" ? m.character_id : null);
    if (effectiveKiller) {
      const kKey = `${patch}|${effectiveKiller}`;
      const prevK = killerDeltas.get(kKey) || {
        patch,
        killer_id: effectiveKiller,
        match_count: 0,
        kills: 0
      };
      prevK.match_count += 1;
      prevK.kills += matchKills;
      killerDeltas.set(kKey, prevK);
    }

    // 6. Perks (jogador, killer enfrentado e participantes)
    for (const perk of m.player_perks || []) {
      addPerk(patch, m.role, perk);
    }
    if (m.role === "survivor") {
      for (const perk of m.killer_perks || []) {
        addPerk(patch, "killer", perk);
      }
    }
    const hasKillerPerks = m.role === "survivor" && Array.isArray(m.killer_perks) && m.killer_perks.length > 0;
    for (const p of participants) {
      if (!p || (p.role !== "survivor" && p.role !== "killer")) continue;
      if (hasKillerPerks && p.role === "killer") continue;
      for (const perk of p.perks || []) {
        addPerk(patch, p.role, perk);
      }
    }
  }

  const stmts: D1PreparedStatement[] = [];

  for (const c of charDeltas.values()) {
    const avgScore = c.scoreCount > 0 ? Math.round(c.scoreSum / c.scoreCount) : null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO public_character_stats (patch_version, role, character_id, match_count, escapes, kills, average_score)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(patch_version, role, character_id) DO UPDATE SET
             average_score = CASE
               WHEN excluded.average_score IS NOT NULL AND public_character_stats.average_score IS NOT NULL THEN
                 CAST(ROUND((public_character_stats.average_score * public_character_stats.match_count + excluded.average_score * excluded.match_count) / CAST(public_character_stats.match_count + excluded.match_count AS REAL)) AS INTEGER)
               WHEN excluded.average_score IS NOT NULL THEN excluded.average_score
               ELSE public_character_stats.average_score
             END,
             match_count = public_character_stats.match_count + excluded.match_count,
             escapes = public_character_stats.escapes + excluded.escapes,
             kills = public_character_stats.kills + excluded.kills`
        )
        .bind(c.patch, c.role, c.character_id, c.match_count, c.escapes, c.kills, avgScore)
    );
  }

  for (const m of mapDeltas.values()) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO public_map_stats (patch_version, role, map_id, match_count, escapes, kills)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(patch_version, role, map_id) DO UPDATE SET
             match_count = public_map_stats.match_count + excluded.match_count,
             escapes = public_map_stats.escapes + excluded.escapes,
             kills = public_map_stats.kills + excluded.kills`
        )
        .bind(m.patch, m.role, m.map_id, m.match_count, m.escapes, m.kills)
    );
  }

  for (const k of killerDeltas.values()) {
    const avgKills = Math.round((k.kills / k.match_count) * 100) / 100;
    stmts.push(
      db
        .prepare(
          `INSERT INTO public_killer_stats (patch_version, killer_id, match_count, kills, average_kills)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(patch_version, killer_id) DO UPDATE SET
             match_count = public_killer_stats.match_count + excluded.match_count,
             kills = public_killer_stats.kills + excluded.kills,
             average_kills = ROUND(CAST(public_killer_stats.kills + excluded.kills AS REAL) / (public_killer_stats.match_count + excluded.match_count), 2)`
        )
        .bind(k.patch, k.killer_id, k.match_count, k.kills, avgKills)
    );
  }

  for (const p of perkDeltas.values()) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO public_perk_stats (patch_version, role, perk_id, usage_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(patch_version, role, perk_id) DO UPDATE SET
             usage_count = public_perk_stats.usage_count + excluded.usage_count`
        )
        .bind(p.patch, p.role, p.perk_id, p.usage_count)
    );
  }

  if (stmts.length > 0) {
    stmts.push(
      db.prepare(
        `INSERT INTO community_meta (key, value_json, updated_at)
         VALUES ('stats_dirty', '1', unixepoch())
         ON CONFLICT(key) DO UPDATE SET value_json = '1', updated_at = unixepoch()`
      )
    );
  }

  return stmts;
}

/**
 * Lê as 4 tabelas compactas `public_*_stats`, agrega o payload final de `/api/community-stats`
 * e salva em `community_meta` (`stats_snapshot`) para que leituras subsequentes custem apenas 1 linha!
 */
async function buildAndPersistStatsSnapshot(db: D1Database): Promise<any> {
  const [charactersRes, mapsRes, killersRes, perksRes] = await Promise.all([
    db
      .prepare(
        "SELECT role, character_id, match_count, escapes, kills, average_score FROM public_character_stats"
      )
      .all<{
        role: string;
        character_id: string;
        match_count: number;
        escapes: number;
        kills: number;
        average_score: number | null;
      }>(),
    db
      .prepare("SELECT role, map_id, match_count, escapes, kills FROM public_map_stats")
      .all<{
        role: string;
        map_id: string;
        match_count: number;
        escapes: number;
        kills: number;
      }>(),
    db
      .prepare("SELECT killer_id, match_count, kills, average_kills FROM public_killer_stats")
      .all<{ killer_id: string; match_count: number; kills: number; average_kills: number }>(),
    db
      .prepare("SELECT role, perk_id, usage_count FROM public_perk_stats")
      .all<{
        role: string;
        perk_id: string;
        usage_count: number;
      }>()
  ]);

  const characterRows = charactersRes.results || [];
  const mapRows = mapsRes.results || [];
  const killerRows = killersRes.results || [];
  const perkRows = perksRes.results || [];

  const aggregate = (
    rows: any[],
    key: string,
    countKey = "match_count"
  ): Array<{ value: string; count: number; pct: number; winrate?: number; average_kills?: number }> => {
    const groups = new Map<string, { count: number; escapes: number; kills: number }>();
    for (const row of rows || []) {
      const value = row[key];
      if (!value) continue;
      const prev = groups.get(value) || { count: 0, escapes: 0, kills: 0 };
      prev.count += Number(row[countKey] || 0);
      prev.escapes += Number(row.escapes || 0);
      prev.kills += Number(row.kills || 0);
      groups.set(value, prev);
    }
    const total = [...groups.values()].reduce((sum, g) => sum + g.count, 0);
    return [...groups]
      .map(([value, g]) => {
        const item: {
          value: string;
          count: number;
          pct: number;
          winrate?: number;
          average_kills?: number;
        } = {
          value,
          count: g.count,
          pct: total ? Math.round((g.count * 1000) / total) / 10 : 0
        };
        if (countKey === "match_count" && g.count > 0) {
          if (g.escapes > 0 || rows.some(r => r[key] === value && r.role === "survivor")) {
            item.winrate = Math.round((g.escapes * 100) / g.count);
          } else if (g.kills > 0 || rows.some(r => r[key] === value && r.role === "killer")) {
            item.winrate = Math.round((g.kills * 100) / (g.count * 4));
            item.average_kills = Math.round((g.kills / g.count) * 10) / 10;
          }
        }
        return item;
      })
      .sort((a, b) => b.count - a.count);
  };

  // Agrega killers entre diferentes patch_versions
  const killerGroups = new Map<string, { count: number; kills: number }>();
  for (const r of killerRows) {
    if (!r.killer_id) continue;
    const prev = killerGroups.get(r.killer_id) || { count: 0, kills: 0 };
    prev.count += Number(r.match_count || 0);
    prev.kills += Number(r.kills || 0);
    killerGroups.set(r.killer_id, prev);
  }

  const totalMatches = mapRows.reduce((sum, r) => sum + Number(r.match_count || 0), 0);

  const responseData = {
    total_matches: totalMatches,
    characters: {
      survivor: aggregate(characterRows.filter(r => r.role === "survivor"), "character_id"),
      killer: aggregate(characterRows.filter(r => r.role === "killer"), "character_id")
    },
    maps: aggregate(mapRows, "map_id"),
    killers: [...killerGroups.entries()]
      .map(([killer, g]) => {
        const avgKills = g.count ? Math.round((g.kills / g.count) * 10) / 10 : 0;
        return {
          killer,
          count: g.count,
          average_kills: avgKills,
          winrate: g.count ? Math.round((avgKills / 4) * 100) : 0
        };
      })
      .sort((a, b) => b.count - a.count),
    perks: {
      survivor: aggregate(perkRows.filter(r => r.role === "survivor"), "perk_id", "usage_count"),
      killer: aggregate(perkRows.filter(r => r.role === "killer"), "perk_id", "usage_count")
    }
  };

  if (totalMatches > 0 || characterRows.length > 0 || killerRows.length > 0) {
    try {
      await ensureSchemaMigrated(db);
      await db.batch([
        db
          .prepare(
            `INSERT INTO community_meta (key, value_json, updated_at)
             VALUES ('stats_snapshot', ?, unixepoch())
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = unixepoch()`
          )
          .bind(JSON.stringify(responseData)),
        db.prepare(
          `INSERT INTO community_meta (key, value_json, updated_at)
           VALUES ('stats_dirty', '0', unixepoch())
           ON CONFLICT(key) DO UPDATE SET value_json = '0', updated_at = unixepoch()`
        )
      ]);
    } catch {
      // Ignora falha não-crítica de persistência de cache
    }
  }

  cachedStatsResponse = { data: responseData, timestamp: Date.now() };
  return responseData;
}

/**
 * Recálculo completo sob demanda (usado apenas no bootstrap inicial se as tabelas estiverem vazias
 * ou via endpoint administrativo `/api/admin/refresh-stats`).
 * Suporta tanto partidas novas (`loadout_json` / `participants_json` inline) quanto legadas.
 */
export async function refreshStats(db: D1Database, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastStatsRefreshTime < STATS_REFRESH_MIN_INTERVAL_MS) {
    return;
  }
  lastStatsRefreshTime = now;
  await ensureSchemaMigrated(db);

  const uniqueMatchesCte = `
    WITH unique_matches AS MATERIALIZED (
      SELECT *
      FROM (
        SELECT
          m.*,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(NULLIF(m.official_match_id, ''), m.played_at), COALESCE(m.map_id, '')
            ORDER BY
              (CASE WHEN m.kills_count IS NOT NULL THEN 1 ELSE 0 END) DESC,
              (CASE WHEN m.killer_id IS NOT NULL AND m.killer_id != '' THEN 1 ELSE 0 END) DESC,
              m.created_at ASC,
              m.id ASC
          ) as rn
        FROM community_matches m
      )
      WHERE rn = 1
    )
  `;

  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM public_character_stats"),
    db.prepare("DELETE FROM public_map_stats"),
    db.prepare("DELETE FROM public_killer_stats"),
    db.prepare("DELETE FROM public_perk_stats"),

    // Character stats
    db.prepare(`
      ${uniqueMatchesCte}
      INSERT INTO public_character_stats (patch_version, role, character_id, match_count, escapes, kills, average_score)
      SELECT
        patch_version,
        role,
        character_id,
        COUNT(*) as match_count,
        SUM(escapes) as escapes,
        SUM(kills) as kills,
        CAST(ROUND(AVG(score)) AS INTEGER) as average_score
      FROM (
        SELECT
          COALESCE(patch_version, 'unknown') as patch_version,
          role,
          character_id,
          CASE WHEN role = 'survivor' AND LOWER(COALESCE(result, '')) LIKE '%escape%' THEN 1 ELSE 0 END as escapes,
          CASE WHEN role = 'killer' THEN COALESCE(kills_count, 0) ELSE 0 END as kills,
          score
        FROM unique_matches
        WHERE character_id IS NOT NULL AND character_id != ''

        UNION ALL

        SELECT
          COALESCE(patch_version, 'unknown') as patch_version,
          'killer' as role,
          killer_id as character_id,
          0 as escapes,
          COALESCE(kills_count, 0) as kills,
          NULL as score
        FROM unique_matches
        WHERE role = 'survivor' AND killer_id IS NOT NULL AND killer_id != ''

        UNION ALL

        -- Participantes inline (partidas novas)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          json_extract(p.value, '$.role') as role,
          json_extract(p.value, '$.character_id') as character_id,
          CASE WHEN json_extract(p.value, '$.role') = 'survivor' AND LOWER(COALESCE(json_extract(p.value, '$.result'), '')) LIKE '%escape%' THEN 1 ELSE 0 END as escapes,
          0 as kills,
          NULL as score
        FROM unique_matches m
        JOIN json_each(CASE WHEN m.participants_json IS NOT NULL AND m.participants_json != '' THEN m.participants_json ELSE '[]' END) p
        WHERE json_extract(p.value, '$.character_id') IS NOT NULL
          AND json_extract(p.value, '$.character_id') != ''
          AND json_extract(p.value, '$.role') IN ('survivor', 'killer')
          AND NOT (m.role = 'survivor' AND json_extract(p.value, '$.role') = 'killer' AND m.killer_id IS NOT NULL AND m.killer_id != '')

        UNION ALL

        -- Participantes da tabela legada (apenas para partidas sem participants_json inline)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          p.role,
          p.character_id,
          CASE WHEN p.role = 'survivor' AND LOWER(COALESCE(p.result, '')) LIKE '%escape%' THEN 1 ELSE 0 END as escapes,
          0 as kills,
          NULL as score
        FROM community_match_participants p
        JOIN unique_matches m ON m.id = p.match_id
        WHERE (m.participants_json IS NULL OR m.participants_json = '[]' OR m.participants_json = '')
          AND p.character_id IS NOT NULL AND p.character_id != ''
          AND p.role IN ('survivor', 'killer')
          AND NOT (m.role = 'survivor' AND p.role = 'killer' AND m.killer_id IS NOT NULL AND m.killer_id != '')
      )
      GROUP BY patch_version, role, character_id
    `),

    // Map stats
    db.prepare(`
      ${uniqueMatchesCte}
      INSERT INTO public_map_stats (patch_version, role, map_id, match_count, escapes, kills)
      SELECT
        COALESCE(patch_version, 'unknown'),
        role,
        COALESCE(map_id, ''),
        COUNT(*),
        SUM(CASE WHEN role = 'survivor' AND LOWER(COALESCE(result, '')) LIKE '%escape%' THEN 1 ELSE 0 END),
        SUM(CASE WHEN role = 'killer' THEN COALESCE(kills_count, 0) ELSE 0 END)
      FROM unique_matches
      WHERE map_id IS NOT NULL AND map_id != ''
      GROUP BY COALESCE(patch_version, 'unknown'), role, COALESCE(map_id, '')
    `),

    // Killer stats
    db.prepare(`
      ${uniqueMatchesCte}
      INSERT INTO public_killer_stats (patch_version, killer_id, match_count, kills, average_kills)
      SELECT
        patch_version,
        killer_id,
        COUNT(*) as match_count,
        SUM(kills) as kills,
        ROUND(CAST(SUM(kills) AS REAL) / COUNT(*), 2) as average_kills
      FROM (
        SELECT
          COALESCE(patch_version, 'unknown') as patch_version,
          COALESCE(killer_id, CASE WHEN role = 'killer' THEN character_id END) as killer_id,
          COALESCE(kills_count, 0) as kills
        FROM unique_matches
        WHERE COALESCE(killer_id, CASE WHEN role = 'killer' THEN character_id END) IS NOT NULL
          AND COALESCE(killer_id, CASE WHEN role = 'killer' THEN character_id END) != ''
      )
      GROUP BY patch_version, killer_id
    `),

    // Perk stats (inline + legado)
    db.prepare(`
      ${uniqueMatchesCte}
      INSERT INTO public_perk_stats (patch_version, role, perk_id, usage_count)
      SELECT
        patch_version,
        role,
        perk_id,
        COUNT(*) as usage_count
      FROM (
        -- Perks inline do jogador
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          m.role as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN json_each(COALESCE(json_extract(m.loadout_json, '$.perks'), '[]')) perk
        WHERE m.loadout_json IS NOT NULL AND m.loadout_json != '{}' AND perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        -- Perks inline do killer enfrentado
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          'killer' as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN json_each(COALESCE(json_extract(m.loadout_json, '$.killer_perks'), '[]')) perk
        WHERE m.role = 'survivor' AND m.loadout_json IS NOT NULL AND m.loadout_json != '{}' AND perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        -- Perks inline dos participantes
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          json_extract(p.value, '$.role') as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN json_each(CASE WHEN m.participants_json IS NOT NULL AND m.participants_json != '' THEN m.participants_json ELSE '[]' END) p
        JOIN json_each(COALESCE(json_extract(p.value, '$.perks'), '[]')) perk
        WHERE json_extract(p.value, '$.role') IN ('survivor', 'killer')
          AND perk.value IS NOT NULL AND perk.value != ''
          AND NOT (
            m.role = 'survivor'
            AND json_extract(p.value, '$.role') = 'killer'
            AND COALESCE(json_extract(m.loadout_json, '$.killer_perks'), '[]') != '[]'
          )

        UNION ALL

        -- Perks da tabela legada community_match_loadouts (apenas quando loadout_json está vazio)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          m.role as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(l.perks_json) perk
        WHERE (m.loadout_json IS NULL OR m.loadout_json = '{}' OR m.loadout_json = '')
          AND perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          'killer' as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(l.killer_perks_json) perk
        WHERE (m.loadout_json IS NULL OR m.loadout_json = '{}' OR m.loadout_json = '')
          AND m.role = 'survivor' AND perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          p.role as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_participants p ON p.match_id = m.id
        LEFT JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(p.perks_json) perk
        WHERE (m.participants_json IS NULL OR m.participants_json = '[]' OR m.participants_json = '')
          AND p.role IN ('survivor', 'killer')
          AND perk.value IS NOT NULL AND perk.value != ''
          AND NOT (
            m.role = 'survivor'
            AND p.role = 'killer'
            AND l.killer_perks_json IS NOT NULL
            AND l.killer_perks_json != '[]'
          )
      )
      GROUP BY patch_version, role, perk_id
    `)
  ];

  await db.batch(statements);
  await buildAndPersistStatsSnapshot(db);
}

async function getUserBackupSummary(
  db: D1Database,
  accountId: string,
  forceRefresh = false
): Promise<{ total_matches: number; last_match_at: string | null }> {
  const now = Date.now();
  if (!forceRefresh) {
    const mem = backupSummaryCache.get(accountId);
    if (mem && mem.expiresAt > now) {
      return { total_matches: mem.total_matches, last_match_at: mem.last_match_at };
    }

    try {
      const metaRow = await db
        .prepare("SELECT value_json FROM community_meta WHERE key = ?")
        .bind(`user_summary:${accountId}`)
        .first<{ value_json: string }>();
      if (metaRow?.value_json) {
        const parsed = JSON.parse(metaRow.value_json);
        if (typeof parsed?.total_matches === "number") {
          backupSummaryCache.set(accountId, {
            total_matches: parsed.total_matches,
            last_match_at: parsed.last_match_at ?? null,
            expiresAt: now + BACKUP_SUMMARY_CACHE_TTL_MS
          });
          return {
            total_matches: parsed.total_matches,
            last_match_at: parsed.last_match_at ?? null
          };
        }
      }
    } catch {
      // Se community_meta não existir ainda, cai para a consulta direta
    }
  }

  const summary = await db
    .prepare(
      `SELECT COUNT(*) as total_matches, MAX(played_at) as last_match_at
       FROM community_matches
       WHERE owner_id = ?`
    )
    .bind(accountId)
    .first<{ total_matches: number; last_match_at: string | null }>();

  const result = {
    total_matches: summary?.total_matches || 0,
    last_match_at: summary?.last_match_at || null
  };

  backupSummaryCache.set(accountId, {
    ...result,
    expiresAt: now + BACKUP_SUMMARY_CACHE_TTL_MS
  });

  try {
    await ensureSchemaMigrated(db);
    await db
      .prepare(
        `INSERT INTO community_meta (key, value_json, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = unixepoch()`
      )
      .bind(`user_summary:${accountId}`, JSON.stringify(result))
      .run();
  } catch {}

  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "");

    // ── Health Check ──
    if (pathname === "" || pathname === "/api/health") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // ── 1. Sessão Anônima (Registro ou Validação) ──
    if (request.method === "POST" && pathname === "/api/auth/session") {
      const existing = await authenticate(request, env);
      if (existing) {
        return json({
          token: request.headers.get("Authorization")!.slice(7).trim(),
          user_id: existing.id,
          email: existing.email,
          email_confirmed: !!existing.email
        });
      }

      const userId = crypto.randomUUID();
      const token = `dbd_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      const tokenHash = await sha256Hex(token);

      await env.DB.prepare(
        "INSERT INTO community_accounts (id, token_hash, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))"
      )
        .bind(userId, tokenHash)
        .run();

      authCache.set(tokenHash, {
        account: { id: userId, email: null },
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS
      });

      return json(
        {
          token,
          user_id: userId,
          email: null,
          email_confirmed: false
        },
        201
      );
    }

    // ── 2. Recuperação de Conta por E-mail ──
    if (request.method === "POST" && pathname === "/api/auth/recover") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const email = typeof body?.email === "string" ? body.email.trim().slice(0, 320) : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "invalid_email" }, 400);
      }

      const candidateAccounts = await env.DB.prepare(`
        SELECT a.id, a.email, COUNT(m.id) as match_count
        FROM community_accounts a
        LEFT JOIN community_matches m ON m.owner_id = a.id
        WHERE LOWER(a.email) = LOWER(?)
        GROUP BY a.id
        ORDER BY match_count DESC, a.created_at ASC
      `)
        .bind(email)
        .all<{ id: string; email: string; match_count: number }>();

      const rows = candidateAccounts.results || [];
      if (rows.length === 0) {
        return json({ error: "account_not_found" }, 404);
      }

      const primary = rows[0];

      for (let i = 1; i < rows.length; i++) {
        const secondaryId = rows[i].id;
        invalidateAccountAuthCache(secondaryId);
        backupSummaryCache.delete(secondaryId);
        await env.DB.batch([
          env.DB.prepare("UPDATE OR IGNORE community_matches SET owner_id = ? WHERE owner_id = ?").bind(primary.id, secondaryId),
          env.DB.prepare("DELETE FROM community_matches WHERE owner_id = ?").bind(secondaryId),
          env.DB.prepare("UPDATE OR IGNORE community_submissions SET owner_id = ? WHERE owner_id = ?").bind(primary.id, secondaryId),
          env.DB.prepare("DELETE FROM community_submissions WHERE owner_id = ?").bind(secondaryId),
          env.DB.prepare("DELETE FROM community_accounts WHERE id = ?").bind(secondaryId)
        ]);
      }

      const newToken = `dbd_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      const newTokenHash = await sha256Hex(newToken);

      invalidateAccountAuthCache(primary.id);
      await env.DB.prepare(
        "UPDATE community_accounts SET token_hash = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(newTokenHash, primary.id)
        .run();

      authCache.set(newTokenHash, {
        account: { id: primary.id, email: primary.email },
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS
      });

      const summary = await getUserBackupSummary(env.DB, primary.id, rows.length > 1);

      return json({
        recovered: true,
        token: newToken,
        user_id: primary.id,
        email: primary.email,
        email_confirmed: true,
        total_matches: summary.total_matches
      });
    }

    // ── 3. Vinculação de E-mail para Recuperação ──
    if (request.method === "POST" && pathname === "/api/auth/link-email") {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const email = typeof body?.email === "string" ? body.email.trim().slice(0, 320) : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "invalid_email" }, 400);
      }

      const existingAccount = await env.DB.prepare(`
        SELECT a.id, a.email, COUNT(m.id) as match_count
        FROM community_accounts a
        LEFT JOIN community_matches m ON m.owner_id = a.id
        WHERE LOWER(a.email) = LOWER(?) AND a.id != ?
        GROUP BY a.id
        ORDER BY match_count DESC, a.created_at ASC
      `)
        .bind(email, account.id)
        .first<{ id: string; email: string; match_count: number }>();

      if (existingAccount) {
        invalidateAccountAuthCache(account.id);
        invalidateAccountAuthCache(existingAccount.id);
        backupSummaryCache.delete(account.id);

        await env.DB.batch([
          env.DB.prepare("UPDATE OR IGNORE community_matches SET owner_id = ? WHERE owner_id = ?").bind(existingAccount.id, account.id),
          env.DB.prepare("DELETE FROM community_matches WHERE owner_id = ?").bind(account.id),
          env.DB.prepare("UPDATE OR IGNORE community_submissions SET owner_id = ? WHERE owner_id = ?").bind(existingAccount.id, account.id),
          env.DB.prepare("DELETE FROM community_submissions WHERE owner_id = ?").bind(account.id),
          env.DB.prepare("DELETE FROM community_accounts WHERE id = ?").bind(account.id)
        ]);

        const newToken = `dbd_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
        const newTokenHash = await sha256Hex(newToken);

        await env.DB.prepare(
          "UPDATE community_accounts SET token_hash = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(newTokenHash, existingAccount.id)
          .run();

        authCache.set(newTokenHash, {
          account: { id: existingAccount.id, email },
          expiresAt: Date.now() + AUTH_CACHE_TTL_MS
        });

        const summary = await getUserBackupSummary(env.DB, existingAccount.id, true);

        return json({
          linked: true,
          email,
          email_confirmed: true,
          recovered: true,
          token: newToken,
          user_id: existingAccount.id,
          total_matches: summary.total_matches
        });
      }

      await env.DB.prepare(
        "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(email, account.id)
        .run();

      account.email = email;
      return json({ linked: true, email, email_confirmed: true, recovered: false });
    }

    // ── 4. Ingestão de Partidas (Reestruturada para Mínima Leitura e Gravação) ──
    if (
      request.method === "POST" &&
      (pathname === "/api/community-ingest" || pathname === "/functions/v1/community-ingest")
    ) {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      let submission: any;
      try {
        submission = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      // Compatibilidade retroativa para ação link_email
      if (submission?.action === "link_email") {
        const email = typeof submission.email === "string" ? submission.email.trim().slice(0, 320) : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);

        const existingAccount = await env.DB.prepare(`
          SELECT a.id, a.email, COUNT(m.id) as match_count
          FROM community_accounts a
          LEFT JOIN community_matches m ON m.owner_id = a.id
          WHERE LOWER(a.email) = LOWER(?) AND a.id != ?
          GROUP BY a.id
          ORDER BY match_count DESC, a.created_at ASC
        `)
          .bind(email, account.id)
          .first<{ id: string; email: string; match_count: number }>();

        if (existingAccount) {
          invalidateAccountAuthCache(account.id);
          invalidateAccountAuthCache(existingAccount.id);
          backupSummaryCache.delete(account.id);

          await env.DB.batch([
            env.DB.prepare("UPDATE OR IGNORE community_matches SET owner_id = ? WHERE owner_id = ?").bind(existingAccount.id, account.id),
            env.DB.prepare("DELETE FROM community_matches WHERE owner_id = ?").bind(account.id),
            env.DB.prepare("UPDATE OR IGNORE community_submissions SET owner_id = ? WHERE owner_id = ?").bind(existingAccount.id, account.id),
            env.DB.prepare("DELETE FROM community_submissions WHERE owner_id = ?").bind(account.id),
            env.DB.prepare("DELETE FROM community_accounts WHERE id = ?").bind(account.id)
          ]);
          const newToken = `dbd_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
          const newTokenHash = await sha256Hex(newToken);
          await env.DB.prepare(
            "UPDATE community_accounts SET token_hash = ?, updated_at = datetime('now') WHERE id = ?"
          )
            .bind(newTokenHash, existingAccount.id)
            .run();

          authCache.set(newTokenHash, {
            account: { id: existingAccount.id, email },
            expiresAt: Date.now() + AUTH_CACHE_TTL_MS
          });

          const summary = await getUserBackupSummary(env.DB, existingAccount.id, true);
          return json({
            linked: true,
            email,
            email_confirmed: true,
            recovered: true,
            token: newToken,
            user_id: existingAccount.id,
            total_matches: summary.total_matches
          });
        }

        await env.DB.prepare(
          "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(email, account.id)
          .run();
        account.email = email;
        return json({ linked: true, email, email_confirmed: true, recovered: false });
      }

      const matches = submission?.payload?.matches;
      if (
        !Array.isArray(matches) ||
        matches.length < 1 ||
        matches.length > 100 ||
        !submission.payload_hash
      ) {
        return json({ error: "invalid_submission" }, 400);
      }

      // 1. Checagem rápida em memória para evitar consulta ao D1 em submissões repetidas
      const now = Date.now();
      const subCacheKey = `${account.id}:${submission.payload_hash}`;
      const cachedSubExpiry = recentSubmissionsCache.get(subCacheKey);
      if (cachedSubExpiry && cachedSubExpiry > now) {
        return json({ accepted: matches.length, duplicate: true });
      }

      const existingSubmission = await env.DB.prepare(
        "SELECT id FROM community_submissions WHERE owner_id = ? AND payload_hash = ?"
      )
        .bind(account.id, submission.payload_hash)
        .first();

      if (existingSubmission) {
        recentSubmissionsCache.set(subCacheKey, now + SUBMISSION_CACHE_TTL_MS);
        return json({ accepted: matches.length, duplicate: true });
      }

      const allowedRoles = new Set(["survivor", "killer"]);
      const clean = matches.map((match: any) => ({
        official_match_id: cleanText(match.official_match_id),
        played_at: match.played_at,
        role: match.role,
        character_id: cleanText(match.character_id),
        map_id: cleanText(match.map_id),
        killer_id: cleanText(match.killer_id),
        result: cleanText(match.result),
        kills_count:
          Number.isInteger(match.kills_count) && match.kills_count >= 0 && match.kills_count <= 4
            ? match.kills_count
            : null,
        duration_sec:
          Number.isInteger(match.duration_sec) && match.duration_sec >= 0 && match.duration_sec <= 86400
            ? match.duration_sec
            : null,
        score:
          Number.isInteger(match.score) && match.score >= 0 && match.score <= 1000000
            ? match.score
            : null,
        patch_version: cleanText(match.patch_version, 40),
        platform: cleanText(match.platform, 40),
        region: cleanText(match.region, 40),
        player_perks: cleanNames(match.player_perks),
        player_item: cleanText(match.player_item),
        player_addons: cleanNames(match.player_addons),
        player_offering: cleanText(match.player_offering),
        killer_perks: cleanNames(match.killer_perks),
        participants: cleanParticipants(match.participants),
        source: "official_stats"
      }));

      if (
        clean.some(
          (match: any) => !allowedRoles.has(match.role) || Number.isNaN(Date.parse(match.played_at))
        )
      ) {
        return json({ error: "invalid_match" }, 400);
      }

      await ensureSchemaMigrated(env.DB);

      // Deduplica partidas dentro do próprio lote mantendo a última ocorrência
      const batchByHash = new Map<string, any>();
      for (const match of clean) {
        const playedAtIso = new Date(match.played_at).toISOString();
        const matchHash = [
          match.official_match_id ?? "",
          playedAtIso,
          match.role,
          match.character_id ?? "",
          match.map_id ?? ""
        ].join("|");
        batchByHash.set(matchHash, {
          ...match,
          played_at_iso: playedAtIso,
          match_hash: matchHash,
          loadout_json: JSON.stringify({
            perks: match.player_perks,
            item: match.player_item,
            addons: match.player_addons,
            offering: match.player_offering,
            killer_perks: match.killer_perks
          }),
          participants_json: JSON.stringify(match.participants)
        });
      }

      const uniqueBatch = [...batchByHash.values()];
      const allHashes = uniqueBatch.map(m => m.match_hash);

      // 2. Consulta apenas os hashes presentes no lote para identificar o que já existe
      // (Evita ON CONFLICT DO UPDATE desnecessário e economiza até 90% das linhas gravadas)
      const existingByHash = new Map<string, any>();
      const HASH_CHUNK = 80; // Seguro abaixo do limite de 100 bind params do D1
      for (let i = 0; i < allHashes.length; i += HASH_CHUNK) {
        const slice = allHashes.slice(i, i + HASH_CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        const existingRes = await env.DB.prepare(
          `SELECT id, match_hash, kills_count, duration_sec, score, character_id, map_id, killer_id, result, loadout_json, participants_json
           FROM community_matches
           WHERE owner_id = ? AND match_hash IN (${placeholders})`
        )
          .bind(account.id, ...slice)
          .all<any>();

        for (const row of existingRes.results || []) {
          existingByHash.set(row.match_hash, row);
        }
      }

      const newMatches: any[] = [];
      const matchesToUpdate: Array<{ id: string; match: any }> = [];

      for (const m of uniqueBatch) {
        const existing = existingByHash.get(m.match_hash);
        if (!existing) {
          newMatches.push(m);
        } else {
          // Só emite UPDATE se algum dado novo foi preenchido ou enriquecido
          const needsUpdate =
            (m.kills_count !== null && m.kills_count !== existing.kills_count) ||
            (m.duration_sec !== null && m.duration_sec !== existing.duration_sec) ||
            (m.score !== null && m.score !== existing.score) ||
            (m.killer_id !== null && m.killer_id !== existing.killer_id) ||
            (m.result !== null && m.result !== existing.result) ||
            (!existing.loadout_json || existing.loadout_json === "{}") ||
            (!existing.participants_json || existing.participants_json === "[]");

          if (needsUpdate) {
            matchesToUpdate.push({ id: existing.id, match: m });
          }
        }
      }

      const statements: D1PreparedStatement[] = [];

      // 3. Registra o payload_hash com payload_json enxuto ('{}') para não desperdiçar armazenamento/I/O
      statements.push(
        env.DB.prepare(
          `INSERT INTO community_submissions (id, owner_id, payload_hash, match_count, payload_json, status, received_at)
           VALUES (?, ?, ?, ?, '{}', 'accepted', datetime('now'))
           ON CONFLICT(owner_id, payload_hash) DO NOTHING`
        ).bind(crypto.randomUUID(), account.id, submission.payload_hash, clean.length)
      );

      // 4. INSERT multi-row para novas partidas (até 4 partidas por instrução SQL, 4 * 19 = 76 bind params < 100)
      // Grava 1 única linha por partida em `community_matches` (com loadout_json e participants_json inline)
      const MULTI_INSERT_SIZE = 4;
      for (let i = 0; i < newMatches.length; i += MULTI_INSERT_SIZE) {
        const group = newMatches.slice(i, i + MULTI_INSERT_SIZE);
        const valuesSql = group
          .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
          .join(", ");
        const bindParams: any[] = [];
        for (const m of group) {
          bindParams.push(
            crypto.randomUUID(),
            account.id,
            m.official_match_id,
            m.match_hash,
            m.played_at_iso,
            m.role,
            m.character_id,
            m.map_id,
            m.killer_id,
            m.result,
            m.kills_count,
            m.duration_sec,
            m.score,
            m.patch_version,
            m.platform,
            m.region,
            m.source,
            m.loadout_json,
            m.participants_json
          );
        }
        statements.push(
          env.DB.prepare(
            `INSERT INTO community_matches (
              id, owner_id, official_match_id, match_hash, played_at, role, character_id,
              map_id, killer_id, result, kills_count, duration_sec, score, patch_version,
              platform, region, source, loadout_json, participants_json, created_at
            ) VALUES ${valuesSql}
            ON CONFLICT(owner_id, match_hash) DO NOTHING`
          ).bind(...bindParams)
        );
      }

      // 5. UPDATE apenas para partidas existentes que realmente ganharam dados novos
      for (const { id, match } of matchesToUpdate) {
        statements.push(
          env.DB.prepare(
            `UPDATE community_matches SET
              kills_count = COALESCE(?, kills_count),
              duration_sec = COALESCE(?, duration_sec),
              score = COALESCE(?, score),
              character_id = COALESCE(?, character_id),
              map_id = COALESCE(?, map_id),
              killer_id = COALESCE(?, killer_id),
              result = COALESCE(?, result),
              loadout_json = ?,
              participants_json = ?
             WHERE id = ?`
          ).bind(
            match.kills_count,
            match.duration_sec,
            match.score,
            match.character_id,
            match.map_id,
            match.killer_id,
            match.result,
            match.loadout_json,
            match.participants_json,
            id
          )
        );
      }

      // 6. Atualização incremental das tabelas de estatísticas públicas apenas para partidas inéditas
      if (newMatches.length > 0) {
        const statStmts = buildIncrementalStatStatements(env.DB, newMatches);
        statements.push(...statStmts);
      }

      const CHUNK_SIZE = 50;
      try {
        for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
          await env.DB.batch(statements.slice(i, i + CHUNK_SIZE));
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (/quota|limit|rate|exceeded|d1_error/i.test(errMsg)) {
          console.error("[Community] Limite D1 atingido na ingestão:", errMsg);
          return json(
            {
              error: "quota_exceeded",
              message:
                "Limite diário de operações do banco Cloudflare D1 atingido. Suas partidas não foram perdidas; tente novamente mais tarde."
            },
            429,
            { "Retry-After": "3600" }
          );
        }
        throw err;
      }

      recentSubmissionsCache.set(subCacheKey, now + SUBMISSION_CACHE_TTL_MS);

      // Atualiza o resumo de backup do usuário em memória e no community_meta sem varrer a tabela caso já estivesse em cache
      if (newMatches.length > 0) {
        const prevSummary = backupSummaryCache.get(account.id);
        const maxNewPlayedAt = newMatches.reduce(
          (max, m) => (!max || m.played_at_iso > max ? m.played_at_iso : max),
          null as string | null
        );
        if (prevSummary) {
          const nextSummary = {
            total_matches: prevSummary.total_matches + newMatches.length,
            last_match_at:
              !prevSummary.last_match_at || (maxNewPlayedAt && maxNewPlayedAt > prevSummary.last_match_at)
                ? maxNewPlayedAt
                : prevSummary.last_match_at
          };
          backupSummaryCache.set(account.id, {
            ...nextSummary,
            expiresAt: now + BACKUP_SUMMARY_CACHE_TTL_MS
          });
          ctx.waitUntil(
            env.DB.prepare(
              `INSERT INTO community_meta (key, value_json, updated_at)
               VALUES (?, ?, unixepoch())
               ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = unixepoch()`
            )
              .bind(`user_summary:${account.id}`, JSON.stringify(nextSummary))
              .run()
              .catch(() => {})
          );
        } else {
          // Remove chave desatualizada de community_meta para recalcular sob demanda
          ctx.waitUntil(
            env.DB.prepare("DELETE FROM community_meta WHERE key = ?")
              .bind(`user_summary:${account.id}`)
              .run()
              .catch(() => {})
          );
        }
      }

      return json({
        accepted: clean.length,
        inserted: newMatches.length,
        updated: matchesToUpdate.length
      });
    }

    // ── 5. Resumo de Backup do Usuário (Cacheado em Memória e em 1 linha no D1) ──
    if (request.method === "GET" && pathname === "/api/user/backup-summary") {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      const summary = await getUserBackupSummary(env.DB, account.id);

      return json(
        {
          user_id: account.id,
          email: account.email,
          total_matches: summary.total_matches,
          last_match_at: summary.last_match_at
        },
        200,
        { "Cache-Control": "private, max-age=120" }
      );
    }

    // ── 6. Download / Restauração das Partidas do Usuário ──
    if (request.method === "GET" && pathname === "/api/user/matches") {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      await ensureSchemaMigrated(env.DB);

      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 1000);
      const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

      // Lê diretamente de community_matches (com loadout_json e participants_json inline)
      const matchesRes = await env.DB.prepare(`
        SELECT
          m.id,
          m.official_match_id,
          m.played_at,
          m.role,
          m.character_id,
          m.map_id,
          m.killer_id,
          m.result,
          m.kills_count,
          m.duration_sec,
          m.score,
          m.loadout_json,
          m.participants_json
        FROM community_matches m
        WHERE m.owner_id = ?
        ORDER BY m.played_at ASC
        LIMIT ? OFFSET ?
      `)
        .bind(account.id, limit, offset)
        .all<any>();

      const rows = matchesRes.results || [];

      // Evita SELECT COUNT(*) se a primeira página já trouxe menos que o limite ou usa o resumo em cache
      let total = 0;
      if (offset === 0 && rows.length < limit) {
        total = rows.length;
      } else {
        const summary = await getUserBackupSummary(env.DB, account.id);
        total = Math.max(summary.total_matches, offset + rows.length);
      }

      // Fallback legado: apenas para partidas antigas que ainda não possuem loadout_json inline
      const legacyIds = rows
        .filter((r: any) => !r.loadout_json || r.loadout_json === "{}")
        .map((r: any) => r.id);

      const legacyLoadoutsByMatch = new Map<string, any>();
      const legacyParticipantsByMatch = new Map<string, any[]>();

      if (legacyIds.length > 0) {
        const L_CHUNK = 80;
        for (let i = 0; i < legacyIds.length; i += L_CHUNK) {
          const slice = legacyIds.slice(i, i + L_CHUNK);
          const placeholders = slice.map(() => "?").join(",");
          const [lRes, pRes] = await Promise.all([
            env.DB.prepare(
              `SELECT match_id, perks_json, item_id, addons_json, offering_id, killer_perks_json
               FROM community_match_loadouts
               WHERE match_id IN (${placeholders})`
            )
              .bind(...slice)
              .all<any>(),
            env.DB.prepare(
              `SELECT match_id, character_id, role, result, perks_json
               FROM community_match_participants
               WHERE match_id IN (${placeholders})`
            )
              .bind(...slice)
              .all<any>()
          ]);

          for (const l of lRes.results || []) {
            legacyLoadoutsByMatch.set(l.match_id, l);
          }

          for (const p of pRes.results || []) {
            if (!legacyParticipantsByMatch.has(p.match_id)) {
              legacyParticipantsByMatch.set(p.match_id, []);
            }
            let perks = [];
            try {
              perks = JSON.parse(p.perks_json);
            } catch {}
            legacyParticipantsByMatch.get(p.match_id)!.push({
              character: p.character_id,
              role: p.role,
              result: p.result,
              perks
            });
          }
        }
      }

      const safeJson = (str: string | null, fallback: any = []) => {
        if (!str) return fallback;
        try {
          return JSON.parse(str);
        } catch {
          return fallback;
        }
      };

      const matches = rows.map((r: any) => {
        let playerPerks: string[] = [];
        let killerPerks: string[] = [];
        let playerAddons: string[] = [];
        let itemId: string | null = null;
        let offeringId: string | null = null;
        let participants: any[] = [];

        if (r.loadout_json && r.loadout_json !== "{}") {
          const parsedLoadout = safeJson(r.loadout_json, {});
          playerPerks = Array.isArray(parsedLoadout.perks) ? parsedLoadout.perks : [];
          killerPerks = Array.isArray(parsedLoadout.killer_perks) ? parsedLoadout.killer_perks : [];
          playerAddons = Array.isArray(parsedLoadout.addons) ? parsedLoadout.addons : [];
          itemId = parsedLoadout.item ?? null;
          offeringId = parsedLoadout.offering ?? null;
        } else {
          const legL = legacyLoadoutsByMatch.get(r.id);
          if (legL) {
            playerPerks = safeJson(legL.perks_json, []);
            killerPerks = safeJson(legL.killer_perks_json, []);
            playerAddons = safeJson(legL.addons_json, []);
            itemId = legL.item_id ?? null;
            offeringId = legL.offering_id ?? null;
          }
        }

        if (r.participants_json && r.participants_json !== "[]") {
          const rawParts = safeJson(r.participants_json, []);
          participants = Array.isArray(rawParts)
            ? rawParts.map((p: any) => ({
                character: p.character_id ?? p.character ?? null,
                role: p.role ?? "survivor",
                result: p.result ?? null,
                perks: Array.isArray(p.perks) ? p.perks : []
              }))
            : [];
        } else {
          participants = legacyParticipantsByMatch.get(r.id) || [];
        }

        return {
          id: r.id,
          source_id: r.official_match_id,
          played_at: r.played_at,
          role: r.role,
          character: r.character_id,
          map: r.map_id,
          duration_sec: r.duration_sec,
          result: r.result,
          score: r.score,
          loadout: {
            perks: playerPerks,
            item: itemId,
            addons: playerAddons,
            offering: offeringId
          },
          killer_info:
            r.killer_id || r.kills_count !== null || killerPerks.length > 0
              ? {
                  killer: r.killer_id,
                  kills_count: r.kills_count,
                  perks: killerPerks
                }
              : undefined,
          participants
        };
      });

      return json({
        matches,
        total,
        offset,
        limit,
        has_more: offset + rows.length < total
      });
    }

    // ── 7. Estatísticas Agregadas para o Overlay UI (Leitura de 1 Linha via Snapshot) ──
    if (request.method === "GET" && pathname === "/api/community-stats") {
      const now = Date.now();

      // 1. Cache em memória no Worker isolate (Zero chamadas ao D1)
      if (cachedStatsResponse && now - cachedStatsResponse.timestamp < STATS_CACHE_TTL_MS) {
        return json(cachedStatsResponse.data, 200, {
          "Cache-Control": "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600",
          "X-Cache": "HIT-MEMORY"
        });
      }

      // 2. Cache Edge da Cloudflare (Zero leituras no D1 em domínios customizados)
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cachedEdge = await cache.match(cacheKey);
      if (cachedEdge) {
        return cachedEdge;
      }

      try {
        // 3. Snapshot pré-serializado em `community_meta` (Apenas 2 linhas lidas por Primary Key!)
        try {
          const metaRes = await env.DB.prepare(
            "SELECT key, value_json, updated_at FROM community_meta WHERE key IN ('stats_snapshot', 'stats_dirty')"
          ).all<{ key: string; value_json: string; updated_at: number }>();

          const metaMap = new Map<string, { value_json: string; updated_at: number }>();
          for (const row of metaRes.results || []) {
            metaMap.set(row.key, row);
          }

          const snap = metaMap.get("stats_snapshot");
          const dirty = metaMap.get("stats_dirty")?.value_json === "1";
          const snapAgeMs = snap ? now - snap.updated_at * 1000 : Infinity;

          // Se o snapshot existe e (não está dirty OU tem menos de 30 minutos), retorna imediatamente lendo só 2 linhas!
          if (snap?.value_json && (!dirty || snapAgeMs < STATS_REFRESH_MIN_INTERVAL_MS)) {
            const parsed = JSON.parse(snap.value_json);
            cachedStatsResponse = { data: parsed, timestamp: now };
            const response = json(parsed, 200, {
              "Cache-Control": "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600",
              "X-Cache": "HIT-D1-SNAPSHOT"
            });
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
            return response;
          }
        } catch {
          // Se community_meta ainda não existir, migra e reconstrói abaixo
        }

        // 4. Constrói o snapshot a partir das tabelas compactas `public_*_stats`
        let responseData = await buildAndPersistStatsSnapshot(env.DB);

        // Se o banco ainda não tinha estatísticas inicializadas, faz o bootstrap único
        if (
          responseData.total_matches === 0 &&
          responseData.characters.survivor.length === 0 &&
          responseData.characters.killer.length === 0 &&
          responseData.killers.length === 0
        ) {
          try {
            await refreshStats(env.DB);
            if (cachedStatsResponse) {
              responseData = cachedStatsResponse.data;
            }
          } catch (err) {
            console.error("Falha ao inicializar estatísticas:", err);
          }
        }

        const response = json(responseData, 200, {
          "Cache-Control": "public, max-age=600, s-maxage=1800, stale-while-revalidate=3600",
          "X-Cache": "MISS"
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (d1Err: any) {
        console.warn("[Community] Erro ao consultar D1 em community-stats:", d1Err?.message || d1Err);
        if (cachedStatsResponse) {
          return json(cachedStatsResponse.data, 200, {
            "Cache-Control": "public, max-age=120",
            "X-Cache": "STALE-FALLBACK"
          });
        }
        return json(
          {
            total_matches: 0,
            characters: { survivor: [], killer: [] },
            maps: [],
            killers: [],
            perks: { survivor: [], killer: [] },
            warning: "temporarily_unavailable"
          },
          200,
          {
            "Cache-Control": "public, max-age=120",
            "X-Cache": "ERROR-FALLBACK"
          }
        );
      }
    }

    // ── 8. Endpoint de Administração para Recálculo Completo Manual ──
    if (request.method === "POST" && pathname === "/api/admin/refresh-stats") {
      const authHeader = request.headers.get("Authorization");
      if (env.ADMIN_KEY && authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        await refreshStats(env.DB, true);
        return json({ refreshed: true });
      } catch (err: any) {
        return json({ error: err?.message || String(err), stack: err?.stack }, 500);
      }
    }

    return json({ error: "not_found" }, 404);
  },

  // ── Gatilho Periódico (Cron Trigger) ──
  // Não executa mais full-table scan em `community_matches`!
  // Apenas reconstrói o snapshot de 1 linha (`stats_snapshot`) a partir das tabelas `public_*_stats`
  // SE e SOMENTE SE novas partidas tiverem sido ingeridas (`stats_dirty = '1'`).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchemaMigrated(env.DB);
          const dirtyRow = await env.DB.prepare(
            "SELECT value_json FROM community_meta WHERE key = 'stats_dirty'"
          ).first<{ value_json: string }>();

          if (dirtyRow?.value_json === "1") {
            await buildAndPersistStatsSnapshot(env.DB);
          }
        } catch (err) {
          console.error("[Community Cron] Erro ao atualizar snapshot:", err);
        }
      })()
    );
  }
};
