import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TRICKY_BASE = "https://dbd.tricky.lol/api";
const BHVR_ASSET_BASE = "https://assets.live.bhvraccount.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const KEYWORD_TRANSLATIONS = {
  exhausted: "Exausto (Exhausted)",
  haste: "Pressa (Haste)",
  undetectable: "Indetectável (Undetectable)",
  exposed: "Exposto (Exposed)",
  broken: "Quebrado (Broken)",
  oblivious: "Alheio (Oblivious)",
  hindered: "Entorpecido (Hindered)",
  endurance: "Resistência (Endurance)",
  deepwound: "Ferida Profunda (Deep Wound)",
  deep_wound: "Ferida Profunda (Deep Wound)",
  hemorrhage: "Hemorragia (Hemorrhage)",
  haemorrhage: "Hemorragia (Hemorrhage)",
  mangled: "Dilacerado (Mangled)",
  blindness: "Cegueira (Blindness)",
  incapacitated: "Incapacitado (Incapacitated)",
  madness: "Loucura (Madness)",
  cursed: "Amaldiçoado (Cursed)",
  blessed: "Abençoado (Blessed)",
  bloodlust: "Sede de Sangue (Bloodlust)"
};

export function slugifyKey(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function formatWikiDescription(rawDescription, tunables) {
  if (!rawDescription) return "";
  let text = String(rawDescription);

  const tunableMap = new Map();
  if (tunables && typeof tunables === "object" && !Array.isArray(tunables)) {
    for (const [k, v] of Object.entries(tunables)) {
      const cleanK = k.toLowerCase().trim();
      const valStr = Array.isArray(v) ? v.join("/") : String(v ?? "");
      tunableMap.set(cleanK, valStr);
      tunableMap.set(cleanK.replace(/%$/, ""), valStr);
    }
  }

  // Replace {Tunable.S07P03.ModifyChestItemSecondAddonChance%} or {Tunable.Key}
  text = text.replace(/\{Tunable\.([^}]+)\}/gi, (_, inner) => {
    const parts = inner.split(".");
    const rawKey = parts[parts.length - 1].toLowerCase().trim();
    const withoutPct = rawKey.replace(/%$/, "");
    const val = tunableMap.get(rawKey) ?? tunableMap.get(withoutPct) ?? tunableMap.get(withoutPct + "%");
    if (val !== undefined && val !== "") {
      return `<strong class="wiki-tunable">${val}</strong>`;
    }
    return `<strong class="wiki-tunable">?</strong>`;
  });

  // Replace positional {0}, {1} when tunables is an array or object values
  if (tunables) {
    const valuesList = Array.isArray(tunables) ? tunables : Object.values(tunables);
    text = text.replace(/\{(\d+)\}/g, (match, idxStr) => {
      const idx = Number.parseInt(idxStr, 10);
      const entry = valuesList[idx];
      if (entry !== undefined) {
        const val = Array.isArray(entry) ? entry.join("/") : String(entry);
        return `<strong class="wiki-tunable">${val}</strong>`;
      }
      return match;
    });
  }

  // Replace {Keyword.X}
  text = text.replace(/\{Keyword\.([^}]+)\}/gi, (_, kw) => {
    const clean = kw.trim();
    const mapped = KEYWORD_TRANSLATIONS[clean.toLowerCase()] || clean;
    return `<strong class="wiki-keyword">${mapped}</strong>`;
  });

  // Replace {Input.X}
  text = text.replace(/\{Input\.([^}]+)\}/gi, () => {
    return `<strong class="wiki-input">Botão de Habilidade Ativa</strong>`;
  });

  return text;
}

export function normalizeWikiData({ perks = {}, addons = {}, items = {}, offerings = {}, characters = {} }) {
  const charByIndex = new Map();
  const normalizedCharacters = {};

  for (const [key, ch] of Object.entries(characters || {})) {
    if (!ch || typeof ch !== "object") continue;
    const numKey = Number(key);
    const name = ch.name || ch.id || key;
    if (!Number.isNaN(numKey)) {
      charByIndex.set(numKey, name);
    }
    const entry = {
      id: ch.id || key,
      name,
      role: ch.role || null,
      difficulty: ch.difficulty || null,
      bio: ch.bio || null,
      perks: Array.isArray(ch.perks) ? ch.perks : []
    };
    normalizedCharacters[key] = entry;
    if (ch.id) normalizedCharacters[ch.id] = entry;
    if (ch.name) normalizedCharacters[ch.name] = entry;
  }

  const normalizedPerks = {};
  for (const [id, p] of Object.entries(perks || {})) {
    if (!p || typeof p !== "object") continue;
    const ownerName = p.character != null ? (charByIndex.get(Number(p.character)) || null) : null;
    const entry = {
      id,
      kind: "perk",
      name: p.name || id,
      role: p.role || "shared",
      owner: ownerName,
      teachable: p.teachable || null,
      categories: Array.isArray(p.categories) ? p.categories : [],
      description: formatWikiDescription(p.description, p.tunables),
      tunables: p.tunables || null,
      image: `${BHVR_ASSET_BASE}/perks/${id}.png`
    };
    normalizedPerks[id] = entry;
  }

  const normalizedAddons = {};
  for (const [id, a] of Object.entries(addons || {})) {
    if (!a || typeof a !== "object") continue;
    const entry = {
      id,
      kind: "addon",
      name: a.name || id,
      role: a.role || null,
      rarity: a.rarity || "common",
      item_type: a.item_type || a.type || null,
      parents: Array.isArray(a.parents) ? a.parents : [],
      description: formatWikiDescription(a.description, null),
      image: `${BHVR_ASSET_BASE}/add-ons/${id}.png`
    };
    normalizedAddons[id] = entry;
  }

  const normalizedItems = {};
  for (const [id, it] of Object.entries(items || {})) {
    if (!it || typeof it !== "object") continue;
    const entry = {
      id,
      kind: "item",
      name: it.name || id,
      role: it.role || "survivor",
      rarity: it.rarity || "common",
      item_type: it.item_type || it.type || "item",
      description: formatWikiDescription(it.description, null),
      image: `${BHVR_ASSET_BASE}/items/${id}.png`
    };
    normalizedItems[id] = entry;
  }

  const normalizedOfferings = {};
  for (const [id, ofr] of Object.entries(offerings || {})) {
    if (!ofr || typeof ofr !== "object") continue;
    const entry = {
      id,
      kind: "offering",
      name: ofr.name || id,
      role: ofr.role || "shared",
      rarity: ofr.rarity || "common",
      tags: Array.isArray(ofr.tags) ? ofr.tags : [],
      description: formatWikiDescription(ofr.description, null),
      image: `${BHVR_ASSET_BASE}/offerings/${id}.png`
    };
    normalizedOfferings[id] = entry;
  }

  return {
    perks: normalizedPerks,
    addons: normalizedAddons,
    items: normalizedItems,
    offerings: normalizedOfferings,
    characters: normalizedCharacters,
    updatedAt: new Date().toISOString()
  };
}

export function createWikiCatalog({
  cachePath,
  fetchImpl = globalThis.fetch
} = {}) {
  let data = {
    perks: {},
    addons: {},
    items: {},
    offerings: {},
    characters: {},
    updatedAt: null
  };
  let refreshPromise = null;

  function loadFromDisk() {
    if (!cachePath || !existsSync(cachePath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      if (parsed && parsed.perks && Object.keys(parsed.perks).length > 0) {
        data = parsed;
        return true;
      }
    } catch {}
    return false;
  }

  function saveToDisk() {
    if (!cachePath) return;
    try {
      writeFileSync(cachePath, JSON.stringify(data), "utf8");
    } catch {}
  }

  function isCacheFresh() {
    if (!data.updatedAt) return false;
    const age = Date.now() - new Date(data.updatedAt).getTime();
    return age >= 0 && age < CACHE_TTL_MS && Object.keys(data.perks).length > 0;
  }

  async function fetchJson(endpoint) {
    const res = await fetchImpl(`${TRICKY_BASE}/${endpoint}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "DBD-Tracker-Overlay"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpoint}`);
    return await res.json();
  }

  async function refresh({ force = false } = {}) {
    if (!force && isCacheFresh()) return data;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        const [perks, addons, items, offerings, characters] = await Promise.all([
          fetchJson("perks"),
          fetchJson("addons"),
          fetchJson("items"),
          fetchJson("offerings"),
          fetchJson("characters")
        ]);
        data = normalizeWikiData({ perks, addons, items, offerings, characters });
        saveToDisk();
      } catch (err) {
        console.warn("[WikiCatalog] Aviso ao atualizar catálogo da API pública:", err.message);
      } finally {
        refreshPromise = null;
      }
      return data;
    })();

    return refreshPromise;
  }

  loadFromDisk();

  return {
    getData: () => data,
    refresh
  };
}
