import assert from "node:assert/strict";
import test from "node:test";
import { createCommunitySubmission, sanitizeCommunityMatches, linkRecoveryEmail } from "./community.js";

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
