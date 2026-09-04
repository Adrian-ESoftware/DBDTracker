import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.js";
import { startServer } from "./server.js";

test("recebe coleta pela API local", async () => {
  const server = startServer(openDatabase(":memory:"), 0, "./map_overlays");
  await new Promise(resolve => server.once("listening", resolve));
  const port = server.address().port;
  const payload = [{ source_id: "api-one", played_at: "2026-06-08T10:00:00Z", role: "killer", character: "Trapper", loadout: { perks: [], addons: [] }, participants: [] }];
  const imported = await fetch(`http://127.0.0.1:${port}/api/matches/bulk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
  const overview = await fetch(`http://127.0.0.1:${port}/api/stats/overview`).then(r => r.json());
  assert.equal(imported.inserted, 1);
  assert.equal(overview.total_matches, 1);
  await fetch(`http://127.0.0.1:${port}/api/official-metrics`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ captured_at: "2026-06-08T10:00:00Z", source_url: "https://stats.deadbydaylight.com/statistics/", metrics: [{ label: "Kills", value: "99" }] })
  });
  const official = await fetch(`http://127.0.0.1:${port}/api/official-metrics`).then(r => r.json());
  assert.equal(official[0].value, "99");
  await fetch(`http://127.0.0.1:${port}/api/top-characters`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ section: "regular-trials", period: "all-time", role: "killer", character: "The Trapper", captured_at: "2026-06-08T10:00:00Z", values: { "Total kills": "3" } })
  });
  const top = await fetch(`http://127.0.0.1:${port}/api/top-characters`).then(r => r.json());
  assert.equal(top[0].character, "The Trapper");
  const blocked = await fetch(`http://127.0.0.1:${port}/api/official-metrics`, { headers: { origin: "https://example.com" } });
  assert.equal(blocked.status, 403);
  const allowed = await fetch(`http://127.0.0.1:${port}/api/official-metrics`, { headers: { origin: "https://stats.deadbydaylight.com" } });
  assert.equal(allowed.status, 200);

  // Teste de map overlays e proteção contra path traversal
  const overlayBlocked = await fetch(`http://127.0.0.1:${port}/api/map-overlays/..%2f..%2fpackage.json`);
  assert.equal(overlayBlocked.status, 403);
  const overlayNotFound = await fetch(`http://127.0.0.1:${port}/api/map-overlays/non_existent.png`);
  assert.equal(overlayNotFound.status, 404);

  await new Promise(resolve => server.close(resolve));
});
