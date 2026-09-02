let BrowserWindow, session, app;
try {
  const electron = await import("electron");
  BrowserWindow = electron.BrowserWindow;
  session = electron.session;
  app = electron.app;
} catch {}
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { ingestMatches, ingestOfficialSections, ingestSnapshots, getBackfillSnapshots } from "./database.js";

const DEFAULT_PROVIDER = "steam";
const INTERVAL_MS = 60_000;

function getConfigPath() {
  try {
    return join(app.getPath("userData"), "config.json");
  } catch {
    return join(process.cwd(), "config.json");
  }
}

export function loadConfig() {
  try {
    const configPath = getConfigPath();
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch (error) {
    console.error("[Collector] Erro ao carregar config.json:", error);
  }
  return {};
}

export function saveConfig(updates) {
  try {
    const configPath = getConfigPath();
    let config = {};
    try {
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      }
    } catch {}
    config = { ...config, ...updates };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return config;
  } catch (error) {
    console.error("[Collector] Erro ao salvar config.json:", error);
  }
}

export function extractAuthToken(authStore) {
  if (!authStore) return null;
  const state = authStore.state || authStore;
  const authToken = state.authToken;
  if (!authToken || !authToken.token) return null;

  // Verifica expiração caso exista (adiciona margem de 30s)
  if (authToken.expirationDate && Date.now() >= (authToken.expirationDate - 30_000)) {
    return null;
  }
  if (authToken.expired) {
    return null;
  }

  return authToken.token;
}

const aliases = {
  id: ["id", "matchId", "match_id", "trialId", "trial_id"],
  date: ["playedAt", "played_at", "date", "createdAt", "timestamp", "startTime"],
  role: ["role", "playerRole", "player_role"],
  character: ["character", "characterName", "character_name", "playerCharacter"],
  map: ["map", "mapName", "map_name"],
  realm: ["realm", "mapRealm", "map_realm"],
  duration: ["durationSec", "duration_sec", "duration", "matchDuration"],
  result: ["result", "outcome", "status"],
  score: ["score", "bloodpoints", "points"],
  perks: ["perks", "perkNames", "perk_names"],
  addons: ["addons", "addOns", "add_ons"],
  offering: ["offering", "offeringName"],
  item: ["item", "itemName"],
  participants: ["participants", "players", "survivors"],
  killer: ["killer", "killerName", "killer_name"],
  kills: ["kills", "killsCount", "kills_count"]
};

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const pick = (source, names) => names.map(name => source?.[name]).find(value => value !== undefined && value !== null);
export const text = value => typeof value === "string" ? value.trim() || undefined : object(value) ? text(value.name ?? value.label ?? value.title ?? value.displayName ?? value.id) : undefined;
export const number = value => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(/[^\d.-]/g, "")) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
};
export const names = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
export const role = value => /VE_Slasher|killer|assass/i.test(text(value) ?? "") ? "killer" : /VE_Camper|survivor|sobreviv/i.test(text(value) ?? "") ? "survivor" : undefined;
export const date = value => {
  const parsed = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
};

export function formatStatus(value) {
  const raw = text(value);
  if (!raw) return undefined;
  if (/VE_Escaped/i.test(raw)) return "ESCAPED";
  if (/VE_Sacrificed/i.test(raw)) return "SACRIFICED";
  if (/VE_Killed/i.test(raw)) return "DEAD";
  if (/VE_SurrenderLoss/i.test(raw)) return "DEFEAT";
  if (/VE_ManuallyLeftMatch|VE_Disconnected/i.test(raw)) return "DISCONNECTED";
  return raw;
}

const loadout = source => ({
  perks: names(pick(source, aliases.perks)), item: text(pick(source, aliases.item)),
  addons: names(pick(source, aliases.addons)), offering: text(pick(source, aliases.offering))
});

export const officialLoadout = player => ({
  perks: names(player?.characterLoadout?.perks),
  item: text(player?.characterLoadout?.power),
  addons: names(player?.characterLoadout?.addOns),
  offering: text(player?.characterLoadout?.offering)
});

export const officialParticipant = player => ({
  character: text(player?.characterName),
  role: role(player?.playerRole) ?? "survivor",
  result: formatStatus(player?.playerStatus),
  score: number(player?.bloodpointsEarned),
  ...officialLoadout(player)
});

export function normalizeOfficialMatch(source) {
  if (!source?.matchStat || !source?.playerStat || !Array.isArray(source?.opponentStat)) return;
  const player = source.playerStat;
  const playerRole = role(player.playerRole);
  if (!playerRole) return;
  const opponents = source.opponentStat.map(officialParticipant);
  const killer = playerRole === "survivor"
    ? source.opponentStat.find(item => role(item.playerRole) === "killer")
    : player;
  const survivors = playerRole === "killer" ? source.opponentStat : [player, ...source.opponentStat.filter(item => role(item.playerRole) === "survivor")];
  const kills = survivors.filter(item => /SACRIFICED|KILLED|MORI|DEAD|DEFEAT/i.test(formatStatus(item.playerStatus) ?? "")).length;
  return {
    source_id: `official-${source.matchStat.matchStartTime}`,
    played_at: date(source.matchStat.matchStartTime),
    role: playerRole,
    character: text(player.characterName),
    map: text(source.matchStat.map) ?? text(source.matchStat.mapName),
    duration_sec: Math.round(number(source.matchStat.matchDuration) ?? 0),
    result: playerRole === "killer" ? `${kills}K` : formatStatus(player.playerStatus),
    score: number(player.bloodpointsEarned),
    loadout: officialLoadout(player),
    killer_info: killer ? {
      killer: text(killer.characterName),
      kills_count: kills,
      perks: names(killer.characterLoadout?.perks),
      addons: names(killer.characterLoadout?.addOns),
      offering: text(killer.characterLoadout?.offering)
    } : undefined,
    participants: opponents,
    raw: source
  };
}

export function normalizeMatch(value) {
  const source = object(value);
  if (!source) return;
  const official = normalizeOfficialMatch(source);
  if (official) return official;
  const playedAt = date(pick(source, aliases.date));
  const playerRole = role(pick(source, aliases.role));
  if (!playedAt || !playerRole) return;
  const killerSource = object(pick(source, aliases.killer));
  const killerName = text(pick(source, aliases.killer)) ?? text(pick(killerSource, aliases.character));
  const rawParticipants = pick(source, aliases.participants);
  return {
    source_id: text(pick(source, aliases.id)), played_at: playedAt, role: playerRole,
    character: text(pick(source, aliases.character)), map: text(pick(source, aliases.map)),
    map_realm: text(pick(source, aliases.realm)), duration_sec: number(pick(source, aliases.duration)),
    result: text(pick(source, aliases.result)), score: number(pick(source, aliases.score)),
    loadout: loadout(source),
    killer_info: killerName || killerSource ? {
      killer: killerName, kills_count: number(pick(killerSource ?? source, aliases.kills)),
      ...loadout(killerSource ?? {})
    } : undefined,
    participants: Array.isArray(rawParticipants) ? rawParticipants.map(item => {
      const participant = object(item) ?? {};
      return {
        character: text(pick(participant, aliases.character)),
        role: role(pick(participant, aliases.role)) ?? "survivor",
        result: text(pick(participant, aliases.result)), score: number(pick(participant, aliases.score)),
        ...loadout(participant)
      };
    }) : [],
    raw: value
  };
}

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

export function findMatches(payload) {
  const found = [];
  const visited = new Set();
  const walk = (value, depth = 0) => {
    if (depth > 8 || visited.has(value)) return;
    if (value && typeof value === "object") visited.add(value);
    const match = normalizeMatch(value);
    if (match) return found.push(match);
    if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
    else if (object(value)) Object.values(value).forEach(item => walk(item, depth + 1));
  };
  walk(payload);

  const map = new Map();
  for (const match of found) {
    if (!match.played_at || !match.role) continue;
    const key = match.source_id || `${match.played_at}|${match.role}`;
    const existing = map.get(key);
    if (!existing || isMoreOrEquallyComplete(match, existing)) {
      map.set(key, match);
    }
  }
  return [...map.values()];
}

async function fetchApi(url, token, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createBackgroundCollector(db, onStatus) {
  let browser = null;
  let timer = null;
  let loginCheckInterval = null;
  let collecting = false;
  let loggedIn = false;
  let lastRun = null;
  let cachedAuthStore = null;

  const state = { message: "Iniciando coletor...", loggedIn, collecting, lastRun };

  const status = (message, extra = {}) => {
    Object.assign(state, { message, loggedIn, collecting, lastRun, ...extra });
    if (typeof onStatus === "function") {
      onStatus(state);
    }
  };

  // Carrega configuração persistente inicial
  const initialConfig = loadConfig();
  if (initialConfig.authStore) {
    cachedAuthStore = initialConfig.authStore;
    if (extractAuthToken(cachedAuthStore)) {
      loggedIn = true;
    }
  }
  if (initialConfig.userEmail) {
    db.userEmail = initialConfig.userEmail;
  }

  async function processPayload(url, payload) {
    if (/\/players\/me$/i.test(url) && payload?.email) {
      const email = payload.email;
      if (db.userEmail !== email) {
        db.userEmail = email;
        saveConfig({ userEmail: email });
        console.log(`[Collector] E-mail do usuário ativo: ${email}`);
      }
    }
    const matches = findMatches(payload);
    if (matches.length) {
      await ingestMatches(db, matches);
    }
    if (/\/player-stats\/games\/dbd\/providers\//i.test(url) && payload?.data) {
      const isRegular = /matchCategory=Regular/i.test(url);
      await ingestOfficialSections(db, {
        data: payload.data,
        section: isRegular ? "regular-trials" : "overview",
        captured_at: new Date().toISOString()
      });
      // Se for a visão geral, preenche também regular-trials como base
      if (!isRegular) {
        await ingestOfficialSections(db, {
          data: payload.data,
          section: "regular-trials",
          captured_at: new Date().toISOString()
        });
      }
    }
    await ingestSnapshots(db, [{
      source_url: url,
      kind: matches.length ? "match-history" : /player-stats\/games/i.test(url) ? "regular-trials" : "statistics",
      captured_at: new Date().toISOString(),
      raw: payload
    }]);
    return matches.length;
  }

  async function backfillSnapshots() {
    try {
      const rows = await getBackfillSnapshots(db);
      for (const row of rows) {
        try { await processPayload(row.source_url, row.raw_json); } catch {}
      }
    } catch {}
  }

  function getActiveToken() {
    if (cachedAuthStore) {
      const token = extractAuthToken(cachedAuthStore);
      if (token) return token;
    }
    const cfg = loadConfig();
    if (cfg.authStore) {
      cachedAuthStore = cfg.authStore;
      const token = extractAuthToken(cachedAuthStore);
      if (token) return token;
    }
    return null;
  }

  function ensureBrowser(show = false) {
    if (browser && !browser.isDestroyed()) {
      if (show && !browser.isVisible()) {
        browser.show();
        browser.focus();
      }
      return browser;
    }

    browser = new BrowserWindow({
      width: 1180,
      height: 820,
      show,
      title: "DBD Tracker - Login oficial",
      webPreferences: {
        partition: "persist:dbd-official",
        contextIsolation: true,
        spellcheck: false,
        enableWebSQL: false
      }
    });

    browser.on("close", event => {
      if (!browser.forceClose) {
        event.preventDefault();
        browser.hide();
        stopLoginWatcher();
      }
    });

    return browser;
  }

  async function checkAndExtractAuth(win) {
    if (!win || win.isDestroyed()) return null;
    try {
      const authRaw = await win.webContents.executeJavaScript(`
        (() => {
          try {
            return localStorage.getItem("auth-store") || null;
          } catch {
            return null;
          }
        })()
      `);

      if (!authRaw) return null;
      const parsed = typeof authRaw === "string" ? JSON.parse(authRaw) : authRaw;
      const token = extractAuthToken(parsed);
      if (!token) return null;

      cachedAuthStore = parsed;
      saveConfig({ authStore: parsed });
      loggedIn = true;
      console.log("[Collector] Token auth-store obtido com sucesso do localStorage!");

      // Tenta obter e-mail do usuário
      try {
        const res = await fetchApi("https://account-backend.bhvr.com/players/me", token, { timeout: 5000 });
        if (res.ok) {
          const profile = await res.json();
          if (profile?.email) {
            db.userEmail = profile.email;
            saveConfig({ userEmail: profile.email });
            console.log(`[Collector] E-mail obtido via API: ${profile.email}`);
          }
        }
      } catch (err) {
        console.warn("[Collector] Aviso ao obter e-mail via API:", err.message);
      }

      return token;
    } catch {
      return null;
    }
  }

  function startLoginWatcher(win) {
    stopLoginWatcher();
    loginCheckInterval = setInterval(async () => {
      if (!win || win.isDestroyed() || !win.isVisible()) {
        stopLoginWatcher();
        return;
      }
      const token = await checkAndExtractAuth(win);
      if (token) {
        stopLoginWatcher();
        status("Login concluído com sucesso! Fechando janela...");
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            win.hide();
          }
          collect();
        }, 1000);
      }
    }, 1500);
  }

  function stopLoginWatcher() {
    if (loginCheckInterval) {
      clearInterval(loginCheckInterval);
      loginCheckInterval = null;
    }
  }

  async function trySilentAuthFromSession() {
    try {
      const hiddenWin = ensureBrowser(false);
      await Promise.race([
        hiddenWin.loadURL("https://stats.deadbydaylight.com/"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000))
      ]);
      await new Promise(r => setTimeout(r, 2000));
      const token = await checkAndExtractAuth(hiddenWin);
      if (!browser?.isVisible()) {
        browser.forceClose = true;
        browser.close();
        browser = null;
      }
      return token;
    } catch {
      if (browser && !browser.isDestroyed() && !browser.isVisible()) {
        browser.forceClose = true;
        browser.close();
        browser = null;
      }
      return null;
    }
  }

  async function collect() {
    if (collecting) return state;
    if (browser && !browser.isDestroyed() && browser.isVisible()) {
      console.log("[Collector] Coleta suspensa enquanto a janela de login está aberta.");
      return state;
    }

    let token = getActiveToken();
    if (!token) {
      console.log("[Collector] Nenhum token válido em cache. Tentando verificar sessão existente...");
      token = await trySilentAuthFromSession();
    }

    if (!token) {
      loggedIn = false;
      status("Sessao expirada ou desconectada. Abra o login uma vez.");
      return state;
    }

    collecting = true;
    status("Atualizando dados via API em segundo plano...");

    try {
      const cfg = loadConfig();
      const provider = cfg.provider || DEFAULT_PROVIDER;

      // 1. Perfil / E-mail
      try {
        const meRes = await fetchApi("https://account-backend.bhvr.com/players/me", token);
        if (meRes.status === 401) {
          throw new Error("UNAUTHORIZED");
        }
        if (meRes.ok) {
          const profile = await meRes.json();
          if (profile?.email && db.userEmail !== profile.email) {
            db.userEmail = profile.email;
            saveConfig({ userEmail: profile.email });
          }
        }
      } catch (err) {
        if (err.message === "UNAUTHORIZED") throw err;
        console.warn("[Collector] Falha ao verificar /players/me:", err.message);
      }

      // 2. Estatísticas Globais (Overview)
      const statsUrl = `https://account-backend.bhvr.com/player-stats/games/dbd/providers/${provider}?lang=en`;
      try {
        const statsRes = await fetchApi(statsUrl, token);
        if (statsRes.status === 401) throw new Error("UNAUTHORIZED");
        if (statsRes.ok) {
          const statsPayload = await statsRes.json();
          await processPayload(statsUrl, statsPayload);
        }
      } catch (err) {
        if (err.message === "UNAUTHORIZED") throw err;
        console.warn("[Collector] Falha ao buscar estatísticas gerais:", err.message);
      }

      // 3. Estatísticas Regular Trials
      const regularUrl = `https://account-backend.bhvr.com/player-stats/games/dbd/providers/${provider}?lang=en&matchCategory=Regular`;
      try {
        const regRes = await fetchApi(regularUrl, token);
        if (regRes.status === 401) throw new Error("UNAUTHORIZED");
        if (regRes.ok) {
          const regPayload = await regRes.json();
          await processPayload(regularUrl, regPayload);
        }
      } catch (err) {
        if (err.message === "UNAUTHORIZED") throw err;
        console.warn("[Collector] Falha ao buscar estatísticas de regular trials:", err.message);
      }

      // 4. Histórico de Partidas
      const historyUrl = `https://account-backend.bhvr.com/player-stats/match-history/games/dbd/providers/${provider}?lang=en&limit=10`;
      try {
        const historyRes = await fetchApi(historyUrl, token);
        if (historyRes.status === 401) throw new Error("UNAUTHORIZED");
        if (historyRes.ok) {
          const historyPayload = await historyRes.json();
          await processPayload(historyUrl, historyPayload);
        }
      } catch (err) {
        if (err.message === "UNAUTHORIZED") throw err;
        console.warn("[Collector] Falha ao buscar histórico de partidas:", err.message);
      }

      lastRun = new Date().toISOString();
      loggedIn = true;
      status("Dados atualizados via API.");
    } catch (error) {
      if (error.message === "UNAUTHORIZED") {
        loggedIn = false;
        cachedAuthStore = null;
        saveConfig({ authStore: null });
        status("Sessao expirada. Abra o login uma vez.");
      } else {
        status(`Falha na coleta: ${error.message}`);
      }
    } finally {
      collecting = false;
      status(state.message);
    }

    return state;
  }

  async function showLogin() {
    stopLoginWatcher();
    const win = ensureBrowser(true);
    await win.loadURL("https://stats.deadbydaylight.com/");
    status("Faca login na janela oficial e o token sera capturado automaticamente.");
    startLoginWatcher(win);
  }

  async function finishLogin() {
    const win = ensureBrowser(false);
    const token = await checkAndExtractAuth(win);
    stopLoginWatcher();
    if (win && !win.isDestroyed()) {
      win.hide();
    }
    if (token) {
      status("Login concluído com sucesso!");
      return collect();
    } else {
      status("Login ainda não detectado. Por favor, conclua o login na janela.");
      return state;
    }
  }

  async function clearLogin() {
    stopLoginWatcher();
    loggedIn = false;
    cachedAuthStore = null;
    db.userEmail = null;
    saveConfig({ authStore: null, userEmail: null });
    status("Login limpo. Faca login novamente.");
    if (browser && !browser.isDestroyed()) {
      await browser.webContents.session.clearStorageData();
      browser.forceClose = true;
      browser.close();
      browser = null;
    } else {
      await session.fromPartition("persist:dbd-official").clearStorageData();
    }
  }

  function start() {
    clearInterval(timer);
    backfillSnapshots();
    collect();
    timer = setInterval(collect, INTERVAL_MS);
  }

  function stop() {
    clearInterval(timer);
    stopLoginWatcher();
    if (browser && !browser.isDestroyed()) {
      browser.forceClose = true;
      browser.close();
      browser = null;
    }
  }

  return {
    start,
    stop,
    collect,
    showLogin,
    finishLogin,
    clearLogin,
    getState: () => state
  };
}
