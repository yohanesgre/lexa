// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resumeOutcome, shouldPersistResume } from "./use-assistant-agent";

// LX-84 / LX-79: the resume route answers with a discriminated JSON ack. A
// non-JSON 2xx is the legacy SSE path and falls back to r.ok; a JSON body
// without ok:true is a failure even on a 2xx.
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  } as unknown as Response;
}

function textResponse(ok: boolean, contentType = "text/event-stream"): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => {
      throw new Error("no json");
    },
  } as unknown as Response;
}

describe("resumeOutcome", () => {
  it("accepts a legacy JSON {ok:true} with no discriminated fields", async () => {
    await expect(resumeOutcome(jsonResponse({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("carries the DO's discriminated ack through", async () => {
    await expect(resumeOutcome(jsonResponse({ ok: true, executed: true }))).resolves.toEqual({
      ok: true,
      executed: true,
    });
    await expect(
      resumeOutcome(jsonResponse({ ok: true, executed: false, reason: "pending" }))
    ).resolves.toEqual({ ok: true, executed: false, reason: "pending" });
    await expect(
      resumeOutcome(jsonResponse({ ok: true, executed: false, reason: "settled" }))
    ).resolves.toEqual({ ok: true, executed: false, reason: "settled" });
  });

  it("rejects a JSON body without ok:true even on a 2xx", async () => {
    await expect(resumeOutcome(jsonResponse({ ok: false }))).resolves.toEqual({ ok: false });
    await expect(resumeOutcome(jsonResponse({}))).resolves.toEqual({ ok: false });
    await expect(resumeOutcome(jsonResponse({ ok: "yes" }))).resolves.toEqual({ ok: false });
  });

  it("rejects a malformed JSON body", async () => {
    const res = {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response;
    await expect(resumeOutcome(res)).resolves.toEqual({ ok: false });
  });

  it("falls back to r.ok for a non-JSON response (legacy SSE path)", async () => {
    await expect(resumeOutcome(textResponse(true))).resolves.toEqual({ ok: true });
    await expect(resumeOutcome(textResponse(false))).resolves.toEqual({ ok: false });
  });
});

describe("shouldPersistResume — the client persist matrix", () => {
  it("persists when the writes ran or the batch is settled/indeterminate", () => {
    expect(shouldPersistResume({ ok: true, executed: true })).toBe(true);
    expect(shouldPersistResume({ ok: true, executed: false, reason: "settled" })).toBe(true);
    expect(shouldPersistResume({ ok: true, executed: false, reason: "indeterminate" })).toBe(true);
    // A 502 (RPC failure) is also indeterminate on the server side but has no
    // body; a legacy undiscriminated {ok:true} counts as resumed.
    expect(shouldPersistResume({ ok: true })).toBe(true);
  });

  it("keeps the batch eligible for pending/unavailable/RPC failure", () => {
    expect(shouldPersistResume({ ok: true, executed: false, reason: "pending" })).toBe(false);
    expect(shouldPersistResume({ ok: true, executed: false, reason: "unavailable" })).toBe(false);
    expect(shouldPersistResume({ ok: false })).toBe(false);
  });
});
