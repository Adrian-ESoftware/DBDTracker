import { createHash, randomUUID } from "node:crypto";

const MAX_MATCHES_PER_UPLOAD = 100;
const cleanText = value => (typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null);
const cleanNumber = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? value : null);
const cleanNames = value =>
  Array.isArray(value)
    ? value
        .filter(item => typeof item === "string" && item.trim())
        .map(item => item.trim().slice(0, 160))
        .slice(0, 8)
    : [];

const cleanParticipants = value =>
  Array.isArray(value)
    ? value.slice(0, 5).map(player => ({
        character_id: cleanText(player?.character_id ?? player?.character),
        role: ["survivor", "killer"].includes(player?.role) ? player.role : null,
        result: cleanText(player?.result),
        perks: cleanNames(player?.perks)
      }))
    : [];

function resolveBaseUrl(url) {
  if (!url) return "";
  let base = String(url).trim().replace(/\/+$/, "");
  base = base.replace(/\/(api\/community-ingest|functions\/v1\/community-ingest)$/, "");
  return base.replace(/\/+$/, "");
}

export class CommunityClient {
  constructor({ apiUrl, storage, fetchImpl = fetch }) {
    this.baseUrl = resolveBaseUrl(apiUrl);
    this.storage = storage;
    this.fetch = fetchImpl;
  }

  getStoredSession() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem("community_session");
      if (!raw) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  saveStoredSession(session) {
    if (!this.storage) return;
    try {
      if (session) {
        this.storage.setItem("community_session", JSON.stringify(session));
      } else {
        this.storage.removeItem("community_session");
      }
    } catch {}
  }

  async getSession() {
    const existing = this.getStoredSession();
    if (!existing?.token) return null;
    return existing;
  }

  async ensureSession() {
    if (!this.baseUrl) throw new Error("Community API is not configured");

    const existing = this.getStoredSession();
    if (existing?.token) {
      try {
        const res = await this.fetch(`${this.baseUrl}/api/auth/session`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${existing.token}`,
            "Content-Type": "application/json"
          }
        });
        if (res.ok) {
          const data = await res.json();
          const session = {
            token: data.token || existing.token,
            access_token: data.token || existing.token,
            user_id: data.user_id || existing.user_id,
            email: data.email ?? existing.email ?? null,
            email_confirmed: !!data.email_confirmed,
            user: {
              id: data.user_id || existing.user_id,
              email: data.email ?? existing.email ?? null,
              email_confirmed_at: data.email_confirmed ? new Date().toISOString() : null
            }
          };
          this.saveStoredSession(session);
          return session;
        }
      } catch (err) {
        console.warn("[Community] Falha ao validar sessão existente na nuvem:", err.message);
        // Em caso de falha transitória de rede, reutiliza a sessão local
        return existing;
      }
    }

    // Cria nova sessão anônima
    const res = await this.fetch(`${this.baseUrl}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    let data = {};
    try {
      data = await res.json();
    } catch {}

    if (!res.ok || !data.token) {
      throw new Error(`Falha ao registrar sessão anônima: ${data.error || res.status}`);
    }

    const newSession = {
      token: data.token,
      access_token: data.token,
      user_id: data.user_id,
      email: data.email ?? null,
      email_confirmed: !!data.email_confirmed,
      user: {
        id: data.user_id,
        email: data.email ?? null,
        email_confirmed_at: data.email_confirmed ? new Date().toISOString() : null
      }
    };
    this.saveStoredSession(newSession);
    return newSession;
  }

  async linkEmail(email) {
    const session = await this.ensureSession();
    const result = await linkRecoveryEmailDirect({
      apiUrl: this.baseUrl,
      accessToken: session.token,
      email,
      fetchImpl: this.fetch
    });

    if (result.token) {
      session.token = result.token;
      session.access_token = result.token;
    }
    if (result.user_id) {
      session.user_id = result.user_id;
    }
    session.email = result.email || email;
    session.email_confirmed = !!result.email_confirmed;
    if (session.user) {
      session.user.id = session.user_id;
      session.user.email = session.email;
      session.user.email_confirmed_at = session.email_confirmed ? new Date().toISOString() : null;
    }
    this.saveStoredSession(session);
    return result;
  }

  async recoverAccount(email) {
    if (!this.baseUrl) throw new Error("Community API is not configured");
    const endpoint = `${this.baseUrl}/api/auth/recover`;
    const res = await this.fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const session = {
      token: data.token,
      access_token: data.token,
      user_id: data.user_id,
      email: data.email,
      email_confirmed: !!data.email_confirmed,
      user: {
        id: data.user_id,
        email: data.email,
        email_confirmed_at: new Date().toISOString()
      }
    };
    this.saveStoredSession(session);
    return { ...data, session };
  }

  async getCloudBackupSummary() {
    if (!this.baseUrl) return null;
    const session = await this.getSession();
    if (!session?.token) return null;
    const endpoint = `${this.baseUrl}/api/user/backup-summary`;
    try {
      const res = await this.fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json"
        }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async restoreUserMatches({ onProgress } = {}) {
    if (!this.baseUrl) throw new Error("Community API is not configured");
    const session = await this.ensureSession();
    const limit = 500;
    let offset = 0;
    let allMatches = [];
    let total = 0;

    while (true) {
      const endpoint = `${this.baseUrl}/api/user/matches?limit=${limit}&offset=${offset}`;
      const res = await this.fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json"
        }
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      total = data.total || 0;
      const batch = Array.isArray(data.matches) ? data.matches : [];
      if (batch.length === 0) break;

      for (const m of batch) {
        allMatches.push(normalizeCloudMatch(m));
      }

      if (typeof onProgress === "function") {
        onProgress({ downloaded: allMatches.length, total });
      }

      if (!data.has_more || allMatches.length >= total) {
        break;
      }
      offset += batch.length;
    }

    return { matches: allMatches, total };
  }

  async fetchStats({ force = false } = {}) {
    if (!this.baseUrl) throw new Error("Community API is not configured");
    return fetchCommunityStats({ apiUrl: this.baseUrl, fetchImpl: this.fetch, force });
  }

  async uploadMatches(matches, metadata = {}) {
    const session = await this.ensureSession();
    return uploadAllCommunityMatches({
      apiUrl: `${this.baseUrl}/api/community-ingest`,
      accessToken: session.token,
      matches,
      metadata,
      storage: this.storage,
      fetchImpl: this.fetch
    });
  }
}

export function createCommunityAuth({ url, apiUrl, storage, fetchImpl = fetch }) {
  const targetUrl = apiUrl || url;
  if (!targetUrl) return null;
  return new CommunityClient({ apiUrl: targetUrl, storage, fetchImpl });
}

export async function ensureAnonymousCommunitySession(client) {
  if (!client) throw new Error("community auth is not configured");
  if (typeof client.ensureSession === "function") {
    return client.ensureSession();
  }
  throw new Error("unsupported community client");
}

export async function linkRecoveryEmail(client, email) {
  if (!client || !email) {
    throw new Error("a valid email is required");
  }
  if (typeof client.linkEmail === "function") {
    return client.linkEmail(email);
  }
  throw new Error("unsupported community client");
}

export async function linkRecoveryEmailDirect({ apiUrl, accessToken, email, fetchImpl = fetch }) {
  if (!apiUrl || !accessToken || !email) {
    throw new Error("community API, access token and email are required");
  }
  const base = resolveBaseUrl(apiUrl);
  const endpoint = `${base}/api/auth/link-email`;

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email })
  });

  let body = {};
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(`Falha ao vincular e-mail: ${body.error || response.status}`);
  }
  return body;
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
    const rawKills =
      match.kills_count ??
      match.killer_info?.kills_count ??
      (match.role === "killer" && typeof match.result === "string" && /^[0-4]K$/i.test(match.result.trim())
        ? Number.parseInt(match.result.trim()[0], 10)
        : null);
    return {
      official_match_id: cleanText(match.source_id ?? match.official_match_id),
      played_at: new Date(match.played_at).toISOString(),
      role: match.role,
      character_id: cleanText(match.character_id ?? match.character),
      map_id: cleanText(match.map_id ?? match.map),
      killer_id: cleanText(match.killer_id ?? match.killer_info?.killer),
      result: cleanText(match.result),
      kills_count: cleanNumber(rawKills, 0, 4),
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
  });
}

export function getCommunityMatchKey(match) {
  const officialId = cleanText(match?.source_id ?? match?.official_match_id) ?? "";
  const playedAt = match?.played_at ? new Date(match.played_at).toISOString() : "";
  const role = match?.role ?? "";
  const characterId = cleanText(match?.character_id ?? match?.character) ?? "";
  const mapId = cleanText(match?.map_id ?? match?.map) ?? "";
  return `${officialId}|${playedAt}|${role}|${characterId}|${mapId}`;
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
  const base = resolveBaseUrl(apiUrl);
  const endpoint = apiUrl.includes("/api/community-ingest") || apiUrl.includes("/functions/v1/community-ingest")
    ? apiUrl
    : `${base}/api/community-ingest`;

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(submission)
  });

  let body = {};
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    const reason = body.error || body.detail || `HTTP ${response.status}`;
    const err = new Error(`Falha na sincronização: ${reason} (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return body;
}

export async function uploadAllCommunityMatches({
  apiUrl,
  accessToken,
  matches,
  metadata = {},
  storage = null,
  fetchImpl = fetch,
  onProgress = null
}) {
  if (!apiUrl || !accessToken) throw new Error("community API and app access token are required");
  if (!Array.isArray(matches) || matches.length === 0) {
    return { accepted: 0, uploaded: 0, skipped: 0, total: 0 };
  }

  const validMatches = matches.filter(
    m => m?.played_at && !Number.isNaN(Date.parse(m.played_at)) && ["survivor", "killer"].includes(m.role)
  );
  if (validMatches.length === 0) {
    return { accepted: 0, uploaded: 0, skipped: 0, total: 0 };
  }

  const storageKey = `community_synced_keys_${createHash("sha256").update(accessToken).digest("hex").slice(0, 16)}`;
  const syncedSet = new Set();
  if (storage && typeof storage.getItem === "function") {
    try {
      const raw = storage.getItem(storageKey);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        for (const item of parsed) syncedSet.add(item);
      }
    } catch {}
  }

  const saveSynced = () => {
    if (!storage || typeof storage.setItem !== "function") return;
    try {
      storage.setItem(storageKey, JSON.stringify([...syncedSet]));
    } catch {}
  };

  // Deduplica mantendo a última ocorrência e filtra partidas já sincronizadas
  const uniqueMap = new Map();
  for (const match of validMatches) {
    const key = getCommunityMatchKey(match);
    if (!syncedSet.has(key)) {
      uniqueMap.set(key, match);
    }
  }

  const pendingMatches = [...uniqueMap.values()];
  const alreadySyncedCount = validMatches.length - pendingMatches.length;
  if (pendingMatches.length === 0) {
    return {
      accepted: validMatches.length,
      uploaded: 0,
      skipped: alreadySyncedCount,
      total: validMatches.length
    };
  }

  let uploaded = 0;
  let skipped = alreadySyncedCount;

  const uploadChunk = async chunk => {
    try {
      await uploadCommunitySubmission({
        apiUrl,
        accessToken,
        matches: chunk,
        metadata,
        fetchImpl
      });
      for (const m of chunk) {
        syncedSet.add(getCommunityMatchKey(m));
      }
      saveSynced();
      uploaded += chunk.length;
      if (typeof onProgress === "function") {
        onProgress({ uploaded, skipped, total: validMatches.length });
      }
    } catch (error) {
      // Se a cota diária ou rate limit foi atingido, aborta imediatamente sem reenviar requisições em cascata
      const isQuotaError = error?.status === 429 || /quota|limit|exceeded|rate|cota|too many requests/i.test(error?.message || "");
      if (isQuotaError) {
        const quotaErr = new Error("Limite diário da nuvem atingido temporariamente. Suas partidas continuam salvas localmente.");
        quotaErr.isQuota = true;
        quotaErr.status = 429;
        throw quotaErr;
      }

      // Se um lote falhar por erro de constraint de chave estrangeira com partida específica,
      // divide recursivamente para enviar as partidas válidas e descartar a conflitante.
      const isConstraintError = /FOREIGN KEY|constraint failed|UNIQUE constraint/i.test(error?.message || "");
      if (isConstraintError) {
        if (chunk.length === 1) {
          syncedSet.add(getCommunityMatchKey(chunk[0]));
          saveSynced();
          skipped += 1;
          if (typeof onProgress === "function") {
            onProgress({ uploaded, skipped, total: validMatches.length });
          }
          return;
        }
        const mid = Math.floor(chunk.length / 2);
        await uploadChunk(chunk.slice(0, mid));
        await uploadChunk(chunk.slice(mid));
        return;
      }
      throw error;
    }
  };

  for (let i = 0; i < pendingMatches.length; i += MAX_MATCHES_PER_UPLOAD) {
    const batch = pendingMatches.slice(i, i + MAX_MATCHES_PER_UPLOAD);
    await uploadChunk(batch);
  }

  return {
    accepted: uploaded + skipped,
    uploaded,
    skipped,
    total: validMatches.length
  };
}

let localStatsCache = null;
let localStatsCacheExpiry = 0;
const CLIENT_STATS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos de cache local

export async function fetchCommunityStats({ apiUrl, fetchImpl = fetch, force = false } = {}) {
  if (!apiUrl) throw new Error("community API is required");

  const now = Date.now();
  if (!force && localStatsCache && now < localStatsCacheExpiry) {
    return localStatsCache;
  }

  const base = resolveBaseUrl(apiUrl);
  const endpoint = `${base}/api/community-stats`;

  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    let body = {};
    try {
      body = await response.json();
    } catch {}

    if (!response.ok) {
      if (response.status === 429 || response.status === 500) {
        if (localStatsCache) return localStatsCache;
        return {
          total_matches: 0,
          characters: { survivor: [], killer: [] },
          maps: [],
          killers: [],
          perks: { survivor: [], killer: [] },
          warning: "temporarily_unavailable"
        };
      }
      throw new Error(`Falha ao obter estatísticas da comunidade: ${body.error || response.status}`);
    }

    localStatsCache = body;
    localStatsCacheExpiry = now + CLIENT_STATS_CACHE_TTL_MS;
    return body;
  } catch (err) {
    if (localStatsCache) return localStatsCache;
    return {
      total_matches: 0,
      characters: { survivor: [], killer: [] },
      maps: [],
      killers: [],
      perks: { survivor: [], killer: [] },
      warning: "temporarily_unavailable"
    };
  }
}


export function normalizeCloudMatch(m) {
  if (!m) return null;
  const loadout = m.loadout || {};
  const killerInfo = m.killer_info || {};
  const perks = Array.isArray(loadout.perks) ? loadout.perks : (Array.isArray(m.player_perks) ? m.player_perks : []);
  const addons = Array.isArray(loadout.addons) ? loadout.addons : (Array.isArray(m.player_addons) ? m.player_addons : []);
  const killerPerks = Array.isArray(killerInfo.perks) ? killerInfo.perks : (Array.isArray(m.killer_perks) ? m.killer_perks : []);

  const hasKiller = killerInfo.killer || m.killer_id || killerInfo.kills_count !== null || m.kills_count !== null || killerPerks.length > 0;

  return {
    id: m.id,
    source_id: m.source_id ?? m.official_match_id ?? null,
    played_at: m.played_at,
    role: m.role,
    character: m.character ?? m.character_id ?? null,
    map: m.map ?? m.map_id ?? null,
    map_realm: m.map_realm ?? null,
    duration_sec: m.duration_sec ?? null,
    result: m.result ?? null,
    score: m.score ?? null,
    loadout: {
      perks,
      item: loadout.item ?? m.player_item ?? null,
      addons,
      offering: loadout.offering ?? m.player_offering ?? null
    },
    killer_info: hasKiller ? {
      killer: killerInfo.killer ?? m.killer_id ?? null,
      kills_count: killerInfo.kills_count ?? m.kills_count ?? null,
      perks: killerPerks,
      addons: Array.isArray(killerInfo.addons) ? killerInfo.addons : [],
      offering: killerInfo.offering ?? null
    } : undefined,
    participants: Array.isArray(m.participants) ? m.participants.map(p => ({
      character: p.character ?? p.character_id ?? null,
      role: p.role ?? "survivor",
      result: p.result ?? null,
      score: p.score ?? null,
      perks: Array.isArray(p.perks) ? p.perks : [],
      addons: Array.isArray(p.addons) ? p.addons : [],
      item: p.item ?? null,
      offering: p.offering ?? null
    })) : []
  };
}

export async function recoverCommunityAccountDirect({ apiUrl, email, fetchImpl = fetch }) {
  if (!apiUrl || !email) throw new Error("community API and email are required");
  const base = resolveBaseUrl(apiUrl);
  const response = await fetchImpl(`${base}/api/auth/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

export async function fetchCloudBackupSummaryDirect({ apiUrl, accessToken, fetchImpl = fetch }) {
  if (!apiUrl || !accessToken) return null;
  const base = resolveBaseUrl(apiUrl);
  const response = await fetchImpl(`${base}/api/user/backup-summary`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

export async function restoreCommunityMatchesDirect({ apiUrl, accessToken, fetchImpl = fetch, onProgress = null }) {
  if (!apiUrl || !accessToken) throw new Error("community API and access token are required");
  const base = resolveBaseUrl(apiUrl);
  const limit = 500;
  let offset = 0;
  let allMatches = [];
  let total = 0;

  while (true) {
    const res = await fetchImpl(`${base}/api/user/matches?limit=${limit}&offset=${offset}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    total = data.total || 0;
    const batch = Array.isArray(data.matches) ? data.matches : [];
    if (batch.length === 0) break;

    for (const m of batch) {
      allMatches.push(normalizeCloudMatch(m));
    }

    if (typeof onProgress === "function") {
      onProgress({ downloaded: allMatches.length, total });
    }

    if (!data.has_more || allMatches.length >= total) {
      break;
    }
    offset += batch.length;
  }

  return { matches: allMatches, total };
}
