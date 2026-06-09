(async () => {
  const API = "http://127.0.0.1:8765/api";
  const capturedAt = new Date().toISOString();
  const clean = value => (value || "").replace(/\s+/g, " ").trim();
  const post = (path, body) => fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch(() => {});

  const textBody = clean(document.body && document.body.innerText);
  const loggedIn = !/sign in|join now|log in|entrar|conectar/i.test(textBody);
  await post("/collector/status", {
    loggedIn,
    message: loggedIn ? "Sessao oficial ativa." : "Sessao expirada. Abra o login uma vez."
  });
  if (!loggedIn) return;

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
  const pick = (source, names) => names.map(name => source && source[name]).find(value => value !== undefined && value !== null);
  const text = value => typeof value === "string" ? value.trim() || undefined : object(value) ? text(value.name ?? value.label ?? value.title ?? value.displayName) : undefined;
  const number = value => {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(/[^\d.-]/g, "")) : undefined;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const names = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
  const role = value => /VE_Slasher|killer|assass/i.test(text(value) ?? "") ? "killer" : /VE_Camper|survivor|sobreviv/i.test(text(value) ?? "") ? "survivor" : undefined;
  const date = value => {
    const parsed = new Date(typeof value === "number" && value < 10000000000 ? value * 1000 : value);
    return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
  };
  const loadout = source => ({
    perks: names(pick(source, aliases.perks)),
    item: text(pick(source, aliases.item)),
    addons: names(pick(source, aliases.addons)),
    offering: text(pick(source, aliases.offering))
  });
  const officialLoadout = player => ({
    perks: names(player && player.characterLoadout && player.characterLoadout.perks),
    item: text(player && player.characterLoadout && player.characterLoadout.power),
    addons: names(player && player.characterLoadout && player.characterLoadout.addOns),
    offering: text(player && player.characterLoadout && player.characterLoadout.offering)
  });
  const officialParticipant = player => ({
    character: text(player && player.characterName),
    role: role(player && player.playerRole) ?? "survivor",
    result: text(player && player.playerStatus),
    score: number(player && player.bloodpointsEarned),
    ...officialLoadout(player)
  });

  function normalizeOfficialMatch(source) {
    if (!source || !source.matchStat || !source.playerStat || !Array.isArray(source.opponentStat)) return;
    const player = source.playerStat;
    const playerRole = role(player.playerRole);
    if (!playerRole) return;
    const opponents = source.opponentStat.map(officialParticipant);
    const killer = playerRole === "survivor" ? source.opponentStat.find(item => role(item.playerRole) === "killer") : player;
    const survivors = playerRole === "killer" ? source.opponentStat : [player, ...source.opponentStat.filter(item => role(item.playerRole) === "survivor")];
    const kills = survivors.filter(item => /SACRIFICED|KILLED|MORI|DEAD/i.test(text(item.playerStatus) ?? "")).length;
    return {
      source_id: `${source.matchStat.matchStartTime}|${source.matchStat.mapName}|${text(player.characterName)}`,
      played_at: date(source.matchStat.matchStartTime),
      role: playerRole,
      character: text(player.characterName),
      map: text(source.matchStat.map) ?? text(source.matchStat.mapName),
      duration_sec: Math.round(number(source.matchStat.matchDuration) ?? 0),
      result: playerRole === "killer" ? `${kills}K` : text(player.playerStatus),
      score: number(player.bloodpointsEarned),
      loadout: officialLoadout(player),
      killer_info: killer ? {
        killer: text(killer.characterName),
        kills_count: kills,
        perks: names(killer.characterLoadout && killer.characterLoadout.perks),
        addons: names(killer.characterLoadout && killer.characterLoadout.addOns),
        offering: text(killer.characterLoadout && killer.characterLoadout.offering)
      } : undefined,
      participants: opponents,
      raw: source
    };
  }

  function normalizeMatch(value) {
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
      source_id: text(pick(source, aliases.id)),
      played_at: playedAt,
      role: playerRole,
      character: text(pick(source, aliases.character)),
      map: text(pick(source, aliases.map)),
      map_realm: text(pick(source, aliases.realm)),
      duration_sec: number(pick(source, aliases.duration)),
      result: text(pick(source, aliases.result)),
      score: number(pick(source, aliases.score)),
      loadout: loadout(source),
      killer_info: killerName || killerSource ? {
        killer: killerName,
        kills_count: number(pick(killerSource ?? source, aliases.kills)),
        ...loadout(killerSource ?? {})
      } : undefined,
      participants: Array.isArray(rawParticipants) ? rawParticipants.map(item => {
        const participant = object(item) ?? {};
        return {
          character: text(pick(participant, aliases.character)),
          role: role(pick(participant, aliases.role)) ?? "survivor",
          result: text(pick(participant, aliases.result)),
          score: number(pick(participant, aliases.score)),
          ...loadout(participant)
        };
      }) : [],
      raw: value
    };
  }

  function findMatches(payload) {
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
    return [...new Map(found.map(match => [`${match.source_id}|${match.played_at}|${match.character}`, match])).values()];
  }

  async function processPayload(url, payload) {
    const matches = findMatches(payload);
    if (matches.length) await post("/matches/bulk", matches);
    if (/\/player-stats\/games\/dbd\/providers\//i.test(url) && payload && payload.data) {
      await post("/official-sections", {
        data: payload.data,
        section: /matchCategory=Regular/i.test(url) ? "regular-trials" : "overview",
        captured_at: capturedAt
      });
    }
    await post("/snapshots/bulk", [{
      source_url: url,
      kind: matches.length ? "match-history" : /player-stats\/games/i.test(url) ? "regular-trials" : "statistics",
      captured_at: capturedAt,
      raw: payload
    }]);
  }

  async function scanResources() {
    const urls = [...new Set(performance.getEntriesByType("resource")
      .map(entry => entry.name)
      .filter(url => /player-stats|match-history|history|match|stat/i.test(url) && /^https:\/\/stats\.deadbydaylight\.com/i.test(url)))];
    for (const url of urls.slice(-40)) {
      try {
        const response = await fetch(url, { credentials: "include" });
        const type = response.headers.get("content-type") || "";
        if (!type.includes("json")) continue;
        await processPayload(url, await response.json());
      } catch {}
    }
  }

  function metrics() {
    const metrics = [], seen = new Set(), lines = document.body.innerText.split(/\n+/).map(clean).filter(Boolean);
    const add = (label, value) => {
      if (!label || !value || !/\d/.test(value) || label.length > 100 || value.length > 80) return;
      const key = label + "|" + value;
      if (!seen.has(key)) { seen.add(key); metrics.push({ label, value }); }
    };
    for (const element of document.querySelectorAll("article,section,li,[class*='card'],[class*='stat'],[data-testid]")) {
      const parts = [...element.querySelectorAll("h1,h2,h3,h4,h5,p,span,strong,dt,dd")].map(node => clean(node.textContent)).filter(Boolean);
      add(parts.find(x => !/^[-+]?\d[\d.,:% hms]*$/i.test(x)), parts.find(x => /\d/.test(x)));
    }
    for (let i = 0; i < lines.length - 1; i++) if (!/\d/.test(lines[i])) add(lines[i], lines[i + 1]);
    return { metrics: metrics.slice(0, 100), text: clean(document.body.innerText).slice(0, 100000) };
  }

  function characterDetail() {
    const lines = document.body.innerText.split(/\n+/).map(clean).filter(Boolean);
    const labels = [
      "Hours played", "Pick Rate", "Escape Rate", "Kill Rate", "Matches played", "Total escapes",
      "Total Bloodpoints earned", "Average Bloodpoints earned", "Total survivors healed",
      "Total times hooked", "Average times hooked", "Total chases won", "Longest chase time",
      "Total kills", "Total hooks", "Average hooks", "Total hits", "Total gens kicked",
      "Total pallets destroyed", "Total walls broken", "Total vaults broken"
    ];
    const values = {};
    for (const label of labels) {
      const index = lines.findIndex(line => line.toLowerCase() === label.toLowerCase());
      if (index >= 0 && lines[index + 1]) values[label] = lines[index + 1];
    }
    const badge = lines.findIndex(line => /top survivor|top killer/i.test(line));
    const activeRole = badge >= 0 && /survivor/i.test(lines[badge]) ? "survivor" : "killer";
    const heading = lines.map(line => line.toLowerCase()).lastIndexOf(activeRole, badge >= 0 ? badge : lines.length);
    const character = heading >= 0 ? lines.slice(heading + 1).find(line =>
      !/top survivor|top killer|hours played|pick rate|escape rate|kill rate/i.test(line) &&
      !/\d/.test(line) && line.length < 60
    ) : undefined;
    return { character, values, text: clean(document.body.innerText).slice(0, 100000) };
  }

  await scanResources();

  const currentMetrics = metrics();
  await post("/official-metrics", {
    source_url: location.href,
    captured_at: capturedAt,
    metrics: currentMetrics.metrics
  });
  await post("/snapshots/bulk", [{ source_url: location.href, kind: "statistics-dom", captured_at: capturedAt, raw: currentMetrics }]);

  const regularTab = [...document.querySelectorAll("button,a,[role=tab]")].find(node => /regular trials/i.test(node.textContent || ""));
  if (regularTab) {
    regularTab.click();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await scanResources();
    await post("/snapshots/bulk", [{ source_url: location.href, kind: "statistics-regular-trials-dom", captured_at: capturedAt, raw: metrics() }]);
  }

  for (const roleName of ["Survivor", "Killer"]) {
    const target = [...document.querySelectorAll("button,a,[role=tab]")].find(node => (node.textContent || "").trim().toLowerCase() === roleName.toLowerCase());
    if (target) {
      target.click();
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    const detail = characterDetail();
    if (detail.character) {
      await post("/top-characters", {
        section: "regular-trials",
        period: "all-time",
        role: roleName.toLowerCase(),
        character: detail.character,
        captured_at: capturedAt,
        values: detail.values
      });
    }
    await post("/snapshots/bulk", [{
      source_url: location.href,
      kind: `statistics-regular-trials-${roleName.toLowerCase()}-dom`,
      captured_at: capturedAt,
      raw: detail
    }]);
  }
})();
