import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json"
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const cleanText = (value: unknown, max = 160) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const cleanNames = (value: unknown) => Array.isArray(value)
  ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim().slice(0, 160)).slice(0, 8)
  : [];
const cleanParticipants = (value: unknown) => Array.isArray(value)
  ? value.slice(0, 5).map((player: any) => ({
    character_id: cleanText(player?.character_id ?? player?.character),
    role: ["survivor", "killer"].includes(player?.role) ? player.role : null,
    result: cleanText(player?.result),
    perks: cleanNames(player?.perks)
  }))
  : [];

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "missing_auth" }, 401);

  const publicClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("DBD_PUBLISHABLE_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: userError } = await publicClient.auth.getUser();
  if (userError || !user) return json({ error: "invalid_auth" }, 401);

  let submission: any;
  try { submission = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("DBD_SERVICE_ROLE_KEY")!);
  if (submission?.action === "link_email") {
    const email = typeof submission.email === "string" ? submission.email.trim().slice(0, 320) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid_email" }, 400);
    const { data, error } = await adminClient.auth.admin.updateUserById(user.id, {
      email,
      email_confirm: true
    });
    if (error) {
      console.error("community email link failed", error);
      return json({ error: "email_link_failed" }, 400);
    }
    return json({ linked: true, email: data.user.email, email_confirmed: !!data.user.email_confirmed_at });
  }
  const matches = submission?.payload?.matches;
  if (!Array.isArray(matches) || matches.length < 1 || matches.length > 100 || !submission.payload_hash) {
    return json({ error: "invalid_submission" }, 400);
  }

  // Do not trust the desktop client: whitelist every field before persistence.
  const allowedRoles = new Set(["survivor", "killer"]);
  const clean = matches.map((match: any) => ({
    official_match_id: cleanText(match.official_match_id),
    played_at: match.played_at,
    role: match.role,
    character_id: cleanText(match.character_id),
    map_id: cleanText(match.map_id),
    killer_id: cleanText(match.killer_id),
    result: cleanText(match.result),
    kills_count: Number.isInteger(match.kills_count) && match.kills_count >= 0 && match.kills_count <= 4 ? match.kills_count : null,
    duration_sec: Number.isInteger(match.duration_sec) && match.duration_sec >= 0 && match.duration_sec <= 86400 ? match.duration_sec : null,
    score: Number.isInteger(match.score) && match.score >= 0 && match.score <= 1000000 ? match.score : null,
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
  if (clean.some((match: any) => !allowedRoles.has(match.role) || Number.isNaN(Date.parse(match.played_at)))) {
    return json({ error: "invalid_match" }, 400);
  }

  const { error } = await adminClient.from("community_submissions").upsert({
    owner_id: user.id,
    payload_hash: submission.payload_hash,
    match_count: clean.length,
    payload: { matches: clean },
    status: "accepted"
  }, { onConflict: "owner_id,payload_hash" });
  if (error) {
    console.error("community_submissions upsert failed", error);
    return json({ error: "community_submissions" }, 500);
  }
  const rows = clean.map((match: any) => ({
    owner_id: user.id,
    official_match_id: match.official_match_id,
    // Stable across uploads/batches: the batch hash must not participate in dedupe.
    match_hash: [match.official_match_id ?? "", match.played_at, match.role, match.character_id ?? "", match.map_id ?? ""].join("|"),
    played_at: new Date(match.played_at).toISOString(),
    role: match.role,
    character_id: match.character_id,
    map_id: match.map_id,
    killer_id: match.killer_id,
    result: match.result,
    kills_count: match.kills_count,
    duration_sec: match.duration_sec,
    score: match.score,
    patch_version: match.patch_version,
    platform: match.platform,
    region: match.region,
    source: match.source
  }));
  const { error: matchError } = await adminClient.from("community_matches").upsert(rows, { onConflict: "owner_id,match_hash" });
  if (matchError) {
    console.error("community_matches upsert failed", matchError);
    return json({ error: "community_matches" }, 500);
  }
  const hashes = rows.map((row: any) => row.match_hash);
  const { data: savedMatches, error: savedMatchError } = await adminClient
    .from("community_matches").select("id, match_hash").eq("owner_id", user.id).in("match_hash", hashes);
  if (savedMatchError) {
    console.error("community_matches lookup failed", savedMatchError);
    return json({ error: "community_matches_lookup" }, 500);
  }
  const ids = new Map((savedMatches ?? []).map((row: any) => [row.match_hash, row.id]));
  const loadouts = clean.map((match: any) => ({
    match_id: ids.get([match.official_match_id ?? "", match.played_at, match.role, match.character_id ?? "", match.map_id ?? ""].join("|")),
    perks: match.player_perks,
    item_id: match.player_item,
    addons: match.player_addons,
    offering_id: match.player_offering,
    killer_perks: match.killer_perks
  })).filter((row: any) => row.match_id);
  if (loadouts.length) {
    const { error: loadoutError } = await adminClient.from("community_match_loadouts").upsert(loadouts, { onConflict: "match_id" });
    if (loadoutError) {
      console.error("community_match_loadouts upsert failed", loadoutError);
      return json({ error: "community_match_loadouts" }, 500);
    }
  }
  const participantRows = clean.flatMap((match: any) => {
    const matchId = ids.get([match.official_match_id ?? "", match.played_at, match.role, match.character_id ?? "", match.map_id ?? ""].join("|"));
    return matchId ? match.participants.map((player: any) => ({ match_id: matchId, ...player })) : [];
  }).filter((player: any) => player.character_id);
  // A tabela atual usa personagem + função como chave de conflito. Dois
  // survivors iguais podem existir na mesma partida, então não deixe o mesmo
  // lote causar erro de cardinalidade no PostgREST.
  const participants = [...new Map(participantRows.map((player: any) => [
    `${player.match_id}|${player.character_id}|${player.role ?? ""}`, player
  ])).values()];
  if (participants.length) {
    const { error: participantError } = await adminClient.from("community_match_participants").upsert(participants, { onConflict: "match_id,character_id,role" });
    if (participantError) {
      console.error("community_match_participants upsert failed", participantError);
      return json({ error: "community_match_participants" }, 500);
    }
  }
  await adminClient.rpc("refresh_community_daily_stats");
  return json({ accepted: clean.length });
});
