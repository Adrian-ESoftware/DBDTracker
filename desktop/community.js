import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const MAX_MATCHES_PER_UPLOAD = 100;
const cleanText = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
const cleanNumber = (value, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : null;
const cleanNames = value => Array.isArray(value)
  ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim().slice(0, 160)).slice(0, 8)
  : [];
const cleanParticipants = value => Array.isArray(value)
  ? value.slice(0, 5).map(player => ({
    character_id: cleanText(player?.character_id ?? player?.character),
    role: ["survivor", "killer"].includes(player?.role) ? player.role : null,
    result: cleanText(player?.result),
    perks: cleanNames(player?.perks)
  }))
  : [];

export function createCommunityAuth({ url, publishableKey, storage }) {
  if (!url || !publishableKey) return null;
  return createClient(url, publishableKey, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, storage }
  });
}

export async function ensureAnonymousCommunitySession(client) {
  if (!client) throw new Error("community auth is not configured");
  const { data: existing, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (existing.session) {
    // A troca do projeto Supabase pode deixar uma sessão antiga persistida.
    // Valida o token no projeto atual antes de reutilizá-lo.
    const { error: userError } = await client.auth.getUser(existing.session.access_token);
    if (!userError) return existing.session;
    await client.auth.signOut();
  }
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

export async function linkRecoveryEmail(client, email) {
  if (!client || !email) {
    throw new Error("a valid email is required");
  }
  const { data, error } = await client.auth.updateUser({ email });
  if (error) throw error;
  return data.user;
}

export function sanitizeCommunityMatches(matches, metadata = {}) {
  if (!Array.isArray(matches)) throw new TypeError("matches must be an array");
  if (matches.length < 1 || matches.length > MAX_MATCHES_PER_UPLOAD) {
    throw new RangeError(`upload must contain 1-${MAX_MATCHES_PER_UPLOAD} matches`);
  }

  return matches.map(match => {
    if (!match?.played_at || !["survivor", "killer"].includes(match.role)) {
      throw new TypeError("each match requires played_at and a valid role");
    }
    const normalized = {
      official_match_id: cleanText(match.source_id),
      played_at: new Date(match.played_at).toISOString(),
      role: match.role,
      character_id: cleanText(match.character_id ?? match.character),
      map_id: cleanText(match.map_id ?? match.map),
      killer_id: cleanText(match.killer_id ?? match.killer_info?.killer),
      result: cleanText(match.result),
      kills_count: cleanNumber(match.kills_count, 0, 4),
      duration_sec: cleanNumber(match.duration_sec, 0, 86400),
      score: cleanNumber(match.score, 0, 1000000),
      patch_version: cleanText(metadata.patch_version),
      platform: cleanText(metadata.platform),
      region: cleanText(metadata.region),
      player_perks: cleanNames(match.player_perks ?? match.loadout?.perks),
      player_item: cleanText(match.player_item ?? match.loadout?.item),
      player_addons: cleanNames(match.player_addons ?? match.loadout?.addons),
      player_offering: cleanText(match.player_offering ?? match.loadout?.offering),
      killer_perks: cleanNames(match.killer_perks ?? match.killer_info?.perks),
      participants: cleanParticipants(match.participants),
      source: "official_stats"
    };
    return normalized;
  });
}

export function createCommunitySubmission(matches, metadata = {}) {
  const sanitized = sanitizeCommunityMatches(matches, metadata);
  const payload = { matches: sanitized };
  const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { id: randomUUID(), payload_hash: payloadHash, match_count: sanitized.length, payload };
}

export async function uploadCommunitySubmission({ apiUrl, accessToken, matches, metadata, fetchImpl = fetch }) {
  if (!apiUrl || !accessToken) throw new Error("community API and app access token are required");
  const submission = createCommunitySubmission(matches, metadata);
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(submission)
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const reason = body.error || body.detail || `HTTP ${response.status}`;
    throw new Error(`Falha na sincronização: ${reason} (${response.status})`);
  }
  return body;
}
