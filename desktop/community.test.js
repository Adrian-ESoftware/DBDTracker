import assert from "node:assert/strict";
import test from "node:test";
import {
  createCommunitySubmission,
  sanitizeCommunityMatches,
  linkRecoveryEmail,
  createCommunityAuth,
  ensureAnonymousCommunitySession,
  linkRecoveryEmailDirect,
  uploadCommunitySubmission,
  uploadAllCommunityMatches,
  fetchCommunityStats
} from "./community.js";

test("community payload removes raw account and participant data", () => {
  const submission = createCommunitySubmission([{
    source_id: "official-id", played_at: "2026-09-04T12:00:00Z", role: "survivor",
    character: "Meg", map: "The MacMillan Estate", score: 24000,
    raw: { email: "private@example.com", token: "secret" },
    participants: [{ character: "The Trapper" }]
  }], { patch_version: "10.0.0", platform: "Steam" });
  assert.equal(submission.match_count, 1);
  assert.equal(submission.payload.matches[0].character_id, "Meg");
  assert.equal(submission.payload.matches[0].patch_version, "10.0.0");
  assert.equal("raw" in submission.payload.matches[0], false);
  assert.equal(JSON.stringify(submission).includes("private@example.com"), false);
  assert.equal(JSON.stringify(submission).includes("secret"), false);
});

test("community payload validates bounds", () => {
  assert.throws(() => sanitizeCommunityMatches([{ played_at: "2026-09-04T12:00:00Z", role: "unknown" }]), /valid role/);
  const [match] = sanitizeCommunityMatches([{ played_at: "2026-09-04T12:00:00Z", role: "killer", score: 9999999 }]);
  assert.equal(match.score, null);
});

test("recovery email is optional but validated when requested", async () => {
  await assert.rejects(() => linkRecoveryEmail(null, "a@b.com"), /valid email/);
});

test("client registers and ensures anonymous session via mock fetch", async () => {
  const store = {};
  const mockStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
  };

  const mockFetch = async (url, options) => {
    if (url.endsWith("/api/auth/session") && options.method === "POST") {
      return {
        ok: true,
        json: async () => ({
          token: "dbd_test_token_12345",
          user_id: "test-user-id",
          email: null,
          email_confirmed: false
        })
      };
    }
    return { ok: false, status: 404 };
  };

  const client = createCommunityAuth({
    apiUrl: "https://dbd-community.example.workers.dev",
    storage: mockStorage,
    fetchImpl: mockFetch
  });

  const session = await ensureAnonymousCommunitySession(client);
  assert.equal(session.token, "dbd_test_token_12345");
  assert.equal(session.user_id, "test-user-id");
  assert.equal(session.access_token, "dbd_test_token_12345");
});

test("linkRecoveryEmailDirect links email successfully", async () => {
  const mockFetch = async (url, options) => {
    assert.match(url, /\/api\/auth\/link-email$/);
    assert.equal(options.headers.Authorization, "Bearer dbd_test_token");
    const body = JSON.parse(options.body);
    assert.equal(body.email, "player@example.com");
    return {
      ok: true,
      json: async () => ({ linked: true, email: body.email, email_confirmed: true })
    };
  };

  const res = await linkRecoveryEmailDirect({
    apiUrl: "https://dbd-community.example.workers.dev",
    accessToken: "dbd_test_token",
    email: "player@example.com",
    fetchImpl: mockFetch
  });

  assert.equal(res.linked, true);
  assert.equal(res.email, "player@example.com");
});

test("fetchCommunityStats fetches aggregated community data", async () => {
  const mockStats = {
    characters: { survivor: [], killer: [] },
    maps: [],
    killers: [{ killer: "The Trapper", count: 10, average_kills: 2.1 }],
    perks: { survivor: [], killer: [] }
  };

  const mockFetch = async (url) => {
    assert.match(url, /\/api\/community-stats$/);
    return {
      ok: true,
      json: async () => mockStats
    };
  };

  const stats = await fetchCommunityStats({
    apiUrl: "https://dbd-community.example.workers.dev",
    fetchImpl: mockFetch
  });

  assert.deepEqual(stats, mockStats);
});

test("uploadAllCommunityMatches envia todas as partidas em lotes de até 100 e trata conflitos", async () => {
  const store = {};
  const mockStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; }
  };

  const allMatches = Array.from({ length: 135 }, (_, i) => ({
    source_id: `official-${1000 + i}`,
    played_at: new Date(Date.UTC(2026, 8, 1, 0, i, 0)).toISOString(),
    role: i % 2 === 0 ? "survivor" : "killer",
    character: i % 2 === 0 ? "Meg Thomas" : "The Trapper",
    map: "Family Residence",
    result: i % 2 === 0 ? "ESCAPED" : "3K",
    score: 25000,
    killer_info: { killer: "The Trapper", kills_count: 3, perks: ["Agitation"] },
    loadout: { perks: ["Sprint Burst"] },
    participants: []
  }));

  const conflictId = "official-1005";
  const uploadedIds = new Set();

  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const batch = body.payload.matches;
    if (batch.some(m => m.official_match_id === conflictId)) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: "FOREIGN KEY constraint failed" })
      };
    }
    for (const m of batch) {
      assert.equal(m.kills_count, 3);
      uploadedIds.add(m.official_match_id);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ accepted: batch.length })
    };
  };

  const res1 = await uploadAllCommunityMatches({
    apiUrl: "https://dbd-community.example.workers.dev",
    accessToken: "dbd_test_token_all",
    matches: allMatches,
    storage: mockStorage,
    fetchImpl: mockFetch
  });

  assert.equal(res1.total, 135);
  assert.equal(res1.uploaded, 134);
  assert.equal(res1.skipped, 1);
  assert.equal(uploadedIds.size, 134);

  // Segunda chamada não deve reenviar partidas já sincronizadas
  let fetchCalled = false;
  const res2 = await uploadAllCommunityMatches({
    apiUrl: "https://dbd-community.example.workers.dev",
    accessToken: "dbd_test_token_all",
    matches: allMatches,
    storage: mockStorage,
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ accepted: 0 }) };
    }
  });
  assert.equal(fetchCalled, false);
  assert.equal(res2.skipped, 135);
});
