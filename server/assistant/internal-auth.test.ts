import { describe, expect, it } from "vitest";
import {
  INTERNAL_AUTH_MAX_SKEW_SECONDS,
  signInternalAuth,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";

const SECRET = "test-master-key-0123456789";
const NOW_MS = 1_700_000_000_000;
const IDENTITY: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: "chat:abc" };

describe("internal HMAC auth", () => {
  it("verifies a freshly signed identity and formats the header as v1:<ts>:<sig>", async () => {
    const header = await signInternalAuth(SECRET, IDENTITY, NOW_MS);
    expect(header).toMatch(/^v1:\d+:[A-Za-z0-9_-]+$/);
    await expect(verifyInternalAuth(SECRET, header, IDENTITY, { nowMs: NOW_MS })).resolves.toBe(true);
  });

  it("accepts a signature exactly at the skew boundary but not one second past it", async () => {
    const header = await signInternalAuth(SECRET, IDENTITY, NOW_MS);
    const boundary = NOW_MS + INTERNAL_AUTH_MAX_SKEW_SECONDS * 1000;
    await expect(verifyInternalAuth(SECRET, header, IDENTITY, { nowMs: boundary })).resolves.toBe(true);
    await expect(verifyInternalAuth(SECRET, header, IDENTITY, { nowMs: boundary + 1000 })).resolves.toBe(false);
  });

  it("rejects a stale signature beyond the 120s skew window", async () => {
    const header = await signInternalAuth(SECRET, IDENTITY, NOW_MS);
    expect(INTERNAL_AUTH_MAX_SKEW_SECONDS).toBe(120);
    await expect(
      verifyInternalAuth(SECRET, header, IDENTITY, { nowMs: NOW_MS + (INTERNAL_AUTH_MAX_SKEW_SECONDS + 1) * 1000 })
    ).resolves.toBe(false);
  });

  it("rejects a forged signature", async () => {
    const header = await signInternalAuth(SECRET, IDENTITY, NOW_MS);
    const forged = `${header.slice(0, -2)}${header.endsWith("AA") ? "BB" : "AA"}`;
    await expect(verifyInternalAuth(SECRET, forged, IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
  });

  it("rejects a signature that does not cover the supplied identity", async () => {
    const header = await signInternalAuth(SECRET, IDENTITY, NOW_MS);
    await expect(
      verifyInternalAuth(SECRET, header, { ...IDENTITY, actorUserId: "user-2" }, { nowMs: NOW_MS })
    ).resolves.toBe(false);
    await expect(
      verifyInternalAuth(SECRET, header, { ...IDENTITY, threadKey: "chat:other" }, { nowMs: NOW_MS })
    ).resolves.toBe(false);
  });

  it("rejects a missing, empty, or malformed header", async () => {
    await expect(verifyInternalAuth(SECRET, null, IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
    await expect(verifyInternalAuth(SECRET, undefined, IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
    await expect(verifyInternalAuth(SECRET, "", IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
    await expect(verifyInternalAuth(SECRET, "v1::", IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
    await expect(verifyInternalAuth(SECRET, "v2:1:AAAA", IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
    await expect(verifyInternalAuth(SECRET, "v1:not-a-number:AAAA", IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
  });

  it("rejects a header signed with a different key", async () => {
    const header = await signInternalAuth("some-other-master-key", IDENTITY, NOW_MS);
    await expect(verifyInternalAuth(SECRET, header, IDENTITY, { nowMs: NOW_MS })).resolves.toBe(false);
  });
});
