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

async function authenticate(
  request: Request,
  env: Env
): Promise<{ id: string; email: string | null } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const account = await env.DB.prepare(
    "SELECT id, email FROM community_accounts WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first<{ id: string; email: string | null }>();

  return account ?? null;
}

export async function refreshStats(db: D1Database): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM public_character_stats"),
    db.prepare("DELETE FROM public_map_stats"),
    db.prepare("DELETE FROM public_killer_stats"),
    db.prepare("DELETE FROM public_perk_stats"),

    // Character stats
    db.prepare(`
      INSERT INTO public_character_stats (patch_version, role, character_id, match_count, escapes, kills, average_score)
      SELECT
        COALESCE(patch_version, 'unknown'),
        role,
        COALESCE(character_id, ''),
        COUNT(*),
        SUM(CASE WHEN role = 'survivor' AND LOWER(COALESCE(result, '')) LIKE '%escape%' THEN 1 ELSE 0 END),
        SUM(CASE WHEN role = 'killer' THEN COALESCE(kills_count, 0) ELSE 0 END),
        CAST(ROUND(AVG(score)) AS INTEGER)
      FROM community_matches
      WHERE character_id IS NOT NULL AND character_id != ''
      GROUP BY COALESCE(patch_version, 'unknown'), role, COALESCE(character_id, '')
    `),

    // Map stats
    db.prepare(`
      INSERT INTO public_map_stats (patch_version, role, map_id, match_count, escapes, kills)
      SELECT
        COALESCE(patch_version, 'unknown'),
        role,
        COALESCE(map_id, ''),
        COUNT(*),
        SUM(CASE WHEN role = 'survivor' AND LOWER(COALESCE(result, '')) LIKE '%escape%' THEN 1 ELSE 0 END),
        SUM(CASE WHEN role = 'killer' THEN COALESCE(kills_count, 0) ELSE 0 END)
      FROM community_matches
      WHERE map_id IS NOT NULL AND map_id != ''
      GROUP BY COALESCE(patch_version, 'unknown'), role, COALESCE(map_id, '')
    `),

    // Killer stats
    db.prepare(`
      INSERT INTO public_killer_stats (patch_version, killer_id, match_count, kills, average_kills)
      SELECT
        COALESCE(patch_version, 'unknown'),
        killer_id,
        COUNT(*),
        SUM(COALESCE(kills_count, 0)),
        ROUND(CAST(SUM(COALESCE(kills_count, 0)) AS REAL) / COUNT(*), 2)
      FROM community_matches
      WHERE killer_id IS NOT NULL AND killer_id != ''
      GROUP BY COALESCE(patch_version, 'unknown'), killer_id
    `),

    // Survivor & Killer perks from JSON
    db.prepare(`
      INSERT INTO public_perk_stats (patch_version, role, perk_id, usage_count)
      SELECT
        COALESCE(m.patch_version, 'unknown'),
        m.role,
        perk.value,
        COUNT(*)
      FROM community_matches m
      JOIN community_match_loadouts l ON l.match_id = m.id
      JOIN json_each(l.perks_json) perk
      WHERE perk.value IS NOT NULL AND perk.value != ''
      GROUP BY COALESCE(m.patch_version, 'unknown'), m.role, perk.value
    `),

    // Killer perks from killer_perks_json
    db.prepare(`
      INSERT INTO public_perk_stats (patch_version, role, perk_id, usage_count)
      SELECT
        COALESCE(m.patch_version, 'unknown'),
        'killer',
        perk.value,
        COUNT(*)
      FROM community_matches m
      JOIN community_match_loadouts l ON l.match_id = m.id
      JOIN json_each(l.killer_perks_json) perk
      WHERE perk.value IS NOT NULL AND perk.value != ''
      GROUP BY COALESCE(m.patch_version, 'unknown'), perk.value
    `)
  ];

  await db.batch(statements);
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

    // ── 2. Vinculação de E-mail para Recuperação ──
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

      await env.DB.prepare(
        "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(email, account.id)
        .run();

      return json({ linked: true, email, email_confirmed: true });
    }

    // ── 3. Ingestão de Partidas ──
    if (request.method === "POST" && (pathname === "/api/community-ingest" || pathname === "/functions/v1/community-ingest")) {
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
        await env.DB.prepare(
          "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(email, account.id)
          .run();
        return json({ linked: true, email, email_confirmed: true });
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

      // Otimização de escrita: se esse payload_hash já foi gravado para o mesmo usuário, retorne OK sem duplicar
      const existingSubmission = await env.DB.prepare(
        "SELECT id FROM community_submissions WHERE owner_id = ? AND payload_hash = ?"
      )
        .bind(account.id, submission.payload_hash)
        .first();

      if (existingSubmission) {
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

      const statements: D1PreparedStatement[] = [];

      // 1. Registro de submission
      statements.push(
        env.DB.prepare(
          `INSERT INTO community_submissions (id, owner_id, payload_hash, match_count, payload_json, status, received_at)
           VALUES (?, ?, ?, ?, ?, 'accepted', datetime('now'))
           ON CONFLICT(owner_id, payload_hash) DO NOTHING`
        ).bind(
          crypto.randomUUID(),
          account.id,
          submission.payload_hash,
          clean.length,
          JSON.stringify({ matches: clean })
        )
      );

      // 2. Partidas, loadouts e participantes
      for (const match of clean) {
        const matchId = crypto.randomUUID();
        const matchHash = [
          match.official_match_id ?? "",
          match.played_at,
          match.role,
          match.character_id ?? "",
          match.map_id ?? ""
        ].join("|");

        statements.push(
          env.DB.prepare(
            `INSERT INTO community_matches (
              id, owner_id, official_match_id, match_hash, played_at, role, character_id,
              map_id, killer_id, result, kills_count, duration_sec, score, patch_version,
              platform, region, source, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(owner_id, match_hash) DO UPDATE SET
              kills_count = excluded.kills_count,
              duration_sec = excluded.duration_sec,
              score = excluded.score,
              character_id = excluded.character_id,
              map_id = excluded.map_id,
              killer_id = excluded.killer_id,
              result = excluded.result`
          ).bind(
            matchId,
            account.id,
            match.official_match_id,
            matchHash,
            new Date(match.played_at).toISOString(),
            match.role,
            match.character_id,
            match.map_id,
            match.killer_id,
            match.result,
            match.kills_count,
            match.duration_sec,
            match.score,
            match.patch_version,
            match.platform,
            match.region,
            match.source
          )
        );

        statements.push(
          env.DB.prepare(
            `INSERT INTO community_match_loadouts (
              match_id, perks_json, item_id, addons_json, offering_id, killer_perks_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(match_id) DO UPDATE SET
              perks_json = excluded.perks_json,
              item_id = excluded.item_id,
              addons_json = excluded.addons_json,
              offering_id = excluded.offering_id,
              killer_perks_json = excluded.killer_perks_json`
          ).bind(
            matchId,
            JSON.stringify(match.player_perks),
            match.player_item,
            JSON.stringify(match.player_addons),
            match.player_offering,
            JSON.stringify(match.killer_perks)
          )
        );

        for (const p of match.participants) {
          if (!p.character_id) continue;
          statements.push(
            env.DB.prepare(
              `INSERT INTO community_match_participants (
                id, match_id, character_id, role, result, perks_json
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(match_id, character_id, role) DO UPDATE SET
                result = excluded.result,
                perks_json = excluded.perks_json`
            ).bind(
              crypto.randomUUID(),
              matchId,
              p.character_id,
              p.role,
              p.result,
              JSON.stringify(p.perks)
            )
          );
        }
      }

      // Executa em lotes seguros para o D1
      const CHUNK_SIZE = 50;
      for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
        await env.DB.batch(statements.slice(i, i + CHUNK_SIZE));
      }

      return json({ accepted: clean.length });
    }

    // ── 4. Estatísticas Agregadas para o Overlay UI ──
    if (request.method === "GET" && pathname === "/api/community-stats") {
      const [charactersRes, mapsRes, killersRes, perksRes] = await Promise.all([
        env.DB.prepare("SELECT role, character_id, match_count FROM public_character_stats").all<{
          role: string;
          character_id: string;
          match_count: number;
        }>(),
        env.DB.prepare("SELECT role, map_id, match_count FROM public_map_stats").all<{
          role: string;
          map_id: string;
          match_count: number;
        }>(),
        env.DB.prepare(
          "SELECT killer_id, match_count, average_kills FROM public_killer_stats"
        ).all<{ killer_id: string; match_count: number; average_kills: number }>(),
        env.DB.prepare("SELECT role, perk_id, usage_count FROM public_perk_stats").all<{
          role: string;
          perk_id: string;
          usage_count: number;
        }>()
      ]);

      const aggregate = (
        rows: any[],
        key: string,
        countKey = "match_count"
      ): Array<{ value: string; count: number; pct: number }> => {
        const groups = new Map<string, number>();
        for (const row of rows || []) {
          const value = row[key];
          if (!value) continue;
          groups.set(value, (groups.get(value) || 0) + Number(row[countKey] || 0));
        }
        const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
        return [...groups]
          .map(([value, count]) => ({
            value,
            count,
            pct: total ? Math.round((count * 1000) / total) / 10 : 0
          }))
          .sort((a, b) => b.count - a.count);
      };

      const characterRows = charactersRes.results || [];
      const mapRows = mapsRes.results || [];
      const perkRows = perksRes.results || [];
      const killerRows = killersRes.results || [];

      // Se todas as tabelas estiverem vazias, executa refresh assíncrono para inicializar
      if (
        characterRows.length === 0 &&
        mapRows.length === 0 &&
        killerRows.length === 0 &&
        perkRows.length === 0
      ) {
        ctx.waitUntil(refreshStats(env.DB));
      }

      const responseData = {
        characters: {
          survivor: aggregate(characterRows.filter(r => r.role === "survivor"), "character_id"),
          killer: aggregate(characterRows.filter(r => r.role === "killer"), "character_id")
        },
        maps: aggregate(mapRows, "map_id"),
        killers: killerRows
          .filter(r => r.killer_id)
          .map(r => ({
            killer: r.killer_id,
            count: Number(r.match_count || 0),
            average_kills: r.average_kills ?? 0
          }))
          .sort((a, b) => b.count - a.count),
        perks: {
          survivor: aggregate(perkRows.filter(r => r.role === "survivor"), "perk_id", "usage_count"),
          killer: aggregate(perkRows.filter(r => r.role === "killer"), "perk_id", "usage_count")
        }
      };

      return json(responseData, 200, {
        "Cache-Control": "public, max-age=60, s-maxage=300"
      });
    }

    // ── 5. Endpoint de Administração para Atualização Manual de Estatísticas ──
    if (request.method === "POST" && pathname === "/api/admin/refresh-stats") {
      const authHeader = request.headers.get("Authorization");
      if (env.ADMIN_KEY && authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return json({ error: "unauthorized" }, 401);
      }
      await refreshStats(env.DB);
      return json({ refreshed: true });
    }

    return json({ error: "not_found" }, 404);
  },

  // ── Gatilho Periódico (Cron Trigger) ──
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshStats(env.DB));
  }
};
