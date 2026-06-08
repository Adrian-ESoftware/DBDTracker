import { createServer } from "node:http";
import { ingestMatches, ingestOfficialMetrics, ingestOfficialSections, ingestSnapshots, ingestTopCharacter, killers, maps, matches, officialMetrics, officialSections, overview, perks, topCharacters, trends, assetImages } from "./database.js";

const allowedOrigin = origin => !origin || origin.startsWith("https://stats.deadbydaylight.com");
const reply = (response, status, body, origin) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(origin && allowedOrigin(origin) ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(body));
};
const body = request => new Promise((resolve, reject) => {
  let value = "";
  request.on("data", chunk => value += chunk);
  request.on("end", () => { try { resolve(JSON.parse(value || "null")); } catch (error) { reject(error); } });
  request.on("error", reject);
});

export function startServer(db, port = 8765) {
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!allowedOrigin(origin)) return reply(response, 403, { detail: "Origin not allowed" });
    if (request.method === "OPTIONS") return reply(response, 204, {}, origin);
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "POST" && url.pathname === "/api/matches/bulk") return reply(response, 200, ingestMatches(db, await body(request)), origin);
      if (request.method === "POST" && url.pathname === "/api/snapshots/bulk") return reply(response, 200, ingestSnapshots(db, await body(request)), origin);
      if (request.method === "POST" && url.pathname === "/api/official-metrics") return reply(response, 200, ingestOfficialMetrics(db, await body(request)), origin);
      if (request.method === "POST" && url.pathname === "/api/official-sections") return reply(response, 200, ingestOfficialSections(db, await body(request)), origin);
      if (request.method === "POST" && url.pathname === "/api/top-characters") return reply(response, 200, ingestTopCharacter(db, await body(request)), origin);
      if (url.pathname === "/api/stats/overview") return reply(response, 200, overview(db), origin);
      if (url.pathname === "/api/stats/killers") return reply(response, 200, killers(db), origin);
      if (url.pathname === "/api/stats/maps") return reply(response, 200, maps(db), origin);
      if (url.pathname === "/api/stats/perks") return reply(response, 200, perks(db, url.searchParams.get("scope") ?? "all"), origin);
      if (url.pathname === "/api/stats/trends") return reply(response, 200, trends(db), origin);
      if (url.pathname === "/api/assets") return reply(response, 200, assetImages(db, url.searchParams.get("type") || null), origin);
      if (url.pathname === "/api/matches") return reply(response, 200, matches(db, Math.min(Number(url.searchParams.get("limit") ?? 100), 500)), origin);
      if (url.pathname === "/api/official-metrics") return reply(response, 200, officialMetrics(db), origin);
      if (url.pathname === "/api/official-sections") return reply(response, 200, officialSections(db), origin);
      if (url.pathname === "/api/top-characters") return reply(response, 200, topCharacters(db), origin);
      if (url.pathname === "/health") return reply(response, 200, { status: "ok" }, origin);
      reply(response, 404, { detail: "Not found" }, origin);
    } catch (error) {
      reply(response, 500, { detail: error.message }, origin);
    }
  }).listen(port, "127.0.0.1");
}
