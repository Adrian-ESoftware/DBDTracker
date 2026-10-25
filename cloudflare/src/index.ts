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
  const uniqueMatchesCte = `
    WITH unique_matches AS (
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

    // Character stats (survivors and killers from deduplicated matches and participants)
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
        -- Matches characters
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

        -- Killer character from survivor matches
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

        -- Participants characters (excluding killer already counted via killer_id in survivor matches)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          p.role,
          p.character_id,
          CASE WHEN p.role = 'survivor' AND LOWER(COALESCE(p.result, '')) LIKE '%escape%' THEN 1 ELSE 0 END as escapes,
          0 as kills,
          NULL as score
        FROM community_match_participants p
        JOIN unique_matches m ON m.id = p.match_id
        WHERE p.character_id IS NOT NULL AND p.character_id != ''
          AND p.role IN ('survivor', 'killer')
          AND NOT (m.role = 'survivor' AND p.role = 'killer' AND m.killer_id IS NOT NULL AND m.killer_id != '')
      )
      GROUP BY patch_version, role, character_id
    `),

    // Map stats (from deduplicated matches)
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

    // Killer stats (from both killer role and survivor matches where killer was encountered, deduplicated)
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

    // Unified Perk stats (Player loadout, killer loadout, and participants from deduplicated matches)
    db.prepare(`
      ${uniqueMatchesCte}
      INSERT INTO public_perk_stats (patch_version, role, perk_id, usage_count)
      SELECT
        patch_version,
        role,
        perk_id,
        COUNT(*) as usage_count
      FROM (
        -- Perks from player loadout (survivor or killer)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          m.role as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(l.perks_json) perk
        WHERE perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        -- Killer perks recorded when player was survivor
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          'killer' as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(l.killer_perks_json) perk
        WHERE m.role = 'survivor' AND perk.value IS NOT NULL AND perk.value != ''

        UNION ALL

        -- Perks from match participants (excluding killer perks already counted via killer_perks_json)
        SELECT
          COALESCE(m.patch_version, 'unknown') as patch_version,
          p.role as role,
          perk.value as perk_id
        FROM unique_matches m
        JOIN community_match_participants p ON p.match_id = m.id
        LEFT JOIN community_match_loadouts l ON l.match_id = m.id
        JOIN json_each(p.perks_json) perk
        WHERE p.role IN ('survivor', 'killer')
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

    // ── 2. Recuperação de Conta por E-mail ──
    if (request.method === "POST" && pathname === "/api/auth/recover") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const email = typeof body?.email === "string" ? body.email.trim().slice(0, 320) : "";
      if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) {
        return json({ error: "invalid_email" }, 400);
      }

      // Procura contas com este e-mail ordenadas pela maior contagem de partidas
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

      // Se houver múltiplas contas com o mesmo e-mail, consolida na primária
      for (let i = 1; i < rows.length; i++) {
        const secondaryId = rows[i].id;
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

      await env.DB.prepare(
        "UPDATE community_accounts SET token_hash = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(newTokenHash, primary.id)
        .run();

      const totalRes = await env.DB.prepare(
        "SELECT COUNT(*) as total FROM community_matches WHERE owner_id = ?"
      ).bind(primary.id).first<{ total: number }>();

      return json({
        recovered: true,
        token: newToken,
        user_id: primary.id,
        email: primary.email,
        email_confirmed: true,
        total_matches: totalRes?.total || 0
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
      if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) {
        return json({ error: "invalid_email" }, 400);
      }

      // Verifica se já existe outra conta com este e-mail
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
        // Consolida: move dados da conta temporária atual para a conta existente com o histórico
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

        const totalRes = await env.DB.prepare(
          "SELECT COUNT(*) as total FROM community_matches WHERE owner_id = ?"
        ).bind(existingAccount.id).first<{ total: number }>();

        return json({
          linked: true,
          email,
          email_confirmed: true,
          recovered: true,
          token: newToken,
          user_id: existingAccount.id,
          total_matches: totalRes?.total || 0
        });
      }

      await env.DB.prepare(
        "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(email, account.id)
        .run();

      return json({ linked: true, email, email_confirmed: true, recovered: false });
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
        if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);

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
          ).bind(newTokenHash, existingAccount.id).run();
          const totalRes = await env.DB.prepare(
            "SELECT COUNT(*) as total FROM community_matches WHERE owner_id = ?"
          ).bind(existingAccount.id).first<{ total: number }>();

          return json({ linked: true, email, email_confirmed: true, recovered: true, token: newToken, user_id: existingAccount.id, total_matches: totalRes?.total || 0 });
        }

        await env.DB.prepare(
          "UPDATE community_accounts SET email = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(email, account.id)
          .run();
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
            ) VALUES (
              (SELECT id FROM community_matches WHERE owner_id = ? AND match_hash = ?),
              ?, ?, ?, ?, ?
            )
            ON CONFLICT(match_id) DO UPDATE SET
              perks_json = excluded.perks_json,
              item_id = excluded.item_id,
              addons_json = excluded.addons_json,
              offering_id = excluded.offering_id,
              killer_perks_json = excluded.killer_perks_json`
          ).bind(
            account.id,
            matchHash,
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
              ) VALUES (
                ?,
                (SELECT id FROM community_matches WHERE owner_id = ? AND match_hash = ?),
                ?, ?, ?, ?
              )
              ON CONFLICT(match_id, character_id, role) DO UPDATE SET
                result = excluded.result,
                perks_json = excluded.perks_json`
            ).bind(
              crypto.randomUUID(),
              account.id,
              matchHash,
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

      ctx.waitUntil(refreshStats(env.DB));

      return json({ accepted: clean.length });
    }

    // ── 5. Resumo de Backup do Usuário ──
    if (request.method === "GET" && pathname === "/api/user/backup-summary") {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      const summary = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_matches,
          MAX(played_at) as last_match_at
        FROM community_matches
        WHERE owner_id = ?
      `)
        .bind(account.id)
        .first<{ total_matches: number; last_match_at: string | null }>();

      return json({
        user_id: account.id,
        email: account.email,
        total_matches: summary?.total_matches || 0,
        last_match_at: summary?.last_match_at || null
      });
    }

    // ── 6. Download / Restauração das Partidas do Usuário ──
    if (request.method === "GET" && pathname === "/api/user/matches") {
      const account = await authenticate(request, env);
      if (!account) return json({ error: "unauthorized" }, 401);

      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 1000);
      const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

      const countRes = await env.DB.prepare(
        "SELECT COUNT(*) as total FROM community_matches WHERE owner_id = ?"
      )
        .bind(account.id)
        .first<{ total: number }>();
      const total = countRes?.total || 0;

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
          l.perks_json,
          l.item_id,
          l.addons_json,
          l.offering_id,
          l.killer_perks_json
        FROM community_matches m
        LEFT JOIN community_match_loadouts l ON l.match_id = m.id
        WHERE m.owner_id = ?
        ORDER BY m.played_at ASC
        LIMIT ? OFFSET ?
      `)
        .bind(account.id, limit, offset)
        .all<any>();

      const rows = matchesRes.results || [];
      const matchIds = rows.map((r: any) => r.id);

      const participantsByMatch = new Map<string, any[]>();
      if (matchIds.length > 0) {
        const P_CHUNK = 50;
        for (let i = 0; i < matchIds.length; i += P_CHUNK) {
          const slice = matchIds.slice(i, i + P_CHUNK);
          const placeholders = slice.map(() => "?").join(",");
          const pRes = await env.DB.prepare(
            `SELECT match_id, character_id, role, result, perks_json FROM community_match_participants WHERE match_id IN (${placeholders})`
          )
            .bind(...slice)
            .all<any>();

          for (const p of pRes.results || []) {
            if (!participantsByMatch.has(p.match_id)) {
              participantsByMatch.set(p.match_id, []);
            }
            let perks = [];
            try {
              perks = JSON.parse(p.perks_json);
            } catch {}
            participantsByMatch.get(p.match_id)!.push({
              character: p.character_id,
              role: p.role,
              result: p.result,
              perks
            });
          }
        }
      }

      const safeJson = (str: string | null) => {
        if (!str) return [];
        try {
          return JSON.parse(str);
        } catch {
          return [];
        }
      };

      const matches = rows.map((r: any) => {
        const playerPerks = safeJson(r.perks_json);
        const killerPerks = safeJson(r.killer_perks_json);
        const playerAddons = safeJson(r.addons_json);
        const participants = participantsByMatch.get(r.id) || [];

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
            item: r.item_id,
            addons: playerAddons,
            offering: r.offering_id
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

    // ── 7. Estatísticas Agregadas para o Overlay UI ──
    if (request.method === "GET" && pathname === "/api/community-stats") {
      const fetchStatTables = () =>
        Promise.all([
          env.DB.prepare("SELECT role, character_id, match_count, escapes, kills, average_score FROM public_character_stats").all<{
            role: string;
            character_id: string;
            match_count: number;
            escapes: number;
            kills: number;
            average_score: number | null;
          }>(),
          env.DB.prepare("SELECT role, map_id, match_count, escapes, kills FROM public_map_stats").all<{
            role: string;
            map_id: string;
            match_count: number;
            escapes: number;
            kills: number;
          }>(),
          env.DB.prepare(
            "SELECT killer_id, match_count, kills, average_kills FROM public_killer_stats"
          ).all<{ killer_id: string; match_count: number; kills: number; average_kills: number }>(),
          env.DB.prepare("SELECT role, perk_id, usage_count FROM public_perk_stats").all<{
            role: string;
            perk_id: string;
            usage_count: number;
          }>()
        ]);

      let [charactersRes, mapsRes, killersRes, perksRes] = await fetchStatTables();

      let characterRows = charactersRes.results || [];
      let mapRows = mapsRes.results || [];
      let perkRows = perksRes.results || [];
      let killerRows = killersRes.results || [];

      // Se todas as tabelas estiverem vazias, executa refresh síncrono para preencher de imediato
      if (
        characterRows.length === 0 &&
        mapRows.length === 0 &&
        killerRows.length === 0 &&
        perkRows.length === 0
      ) {
        try {
          await refreshStats(env.DB);
          [charactersRes, mapsRes, killersRes, perksRes] = await fetchStatTables();
          characterRows = charactersRes.results || [];
          mapRows = mapsRes.results || [];
          perkRows = perksRes.results || [];
          killerRows = killersRes.results || [];
        } catch (err) {
          console.error("Falha ao inicializar estatísticas:", err);
        }
      }

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
            const item: { value: string; count: number; pct: number; winrate?: number; average_kills?: number } = {
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

      const totalMatches = mapRows.reduce((sum, r) => sum + Number(r.match_count || 0), 0);

      const responseData = {
        total_matches: totalMatches,
        characters: {
          survivor: aggregate(characterRows.filter(r => r.role === "survivor"), "character_id"),
          killer: aggregate(characterRows.filter(r => r.role === "killer"), "character_id")
        },
        maps: aggregate(mapRows, "map_id"),
        killers: killerRows
          .filter(r => r.killer_id)
          .map(r => {
            const count = Number(r.match_count || 0);
            const kills = Number(r.kills || 0);
            const avgKills = r.average_kills ?? (count ? Math.round((kills / count) * 10) / 10 : 0);
            return {
              killer: r.killer_id,
              count,
              average_kills: avgKills,
              winrate: count ? Math.round((avgKills / 4) * 100) : 0
            };
          })
          .sort((a, b) => b.count - a.count),
        perks: {
          survivor: aggregate(perkRows.filter(r => r.role === "survivor"), "perk_id", "usage_count"),
          killer: aggregate(perkRows.filter(r => r.role === "killer"), "perk_id", "usage_count")
        }
      };

      const hasData = characterRows.length > 0 || mapRows.length > 0 || killerRows.length > 0 || perkRows.length > 0;
      return json(responseData, 200, {
        "Cache-Control": hasData ? "public, max-age=60, s-maxage=300" : "no-cache"
      });
    }

    // ── 5. Endpoint de Administração para Atualização Manual de Estatísticas ──
    if (request.method === "POST" && pathname === "/api/admin/refresh-stats") {
      const authHeader = request.headers.get("Authorization");
      if (env.ADMIN_KEY && authHeader !== `Bearer ${env.ADMIN_KEY}`) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        await refreshStats(env.DB);
        return json({ refreshed: true });
      } catch (err: any) {
        return json({ error: err?.message || String(err), stack: err?.stack }, 500);
      }
    }

    return json({ error: "not_found" }, 404);
  },

  // ── Gatilho Periódico (Cron Trigger) ──
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshStats(env.DB));
  }
};
