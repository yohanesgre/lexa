// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { guardResumeProbe, resumeOutcome, shouldPersistResume } from "./use-assistant-agent";

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

const PROBE = JSON.stringify({ type: "cf_agent_stream_resume_request" });

function socket(readyState: number, shouldReconnect: boolean) {
  const sent: unknown[] = [];
  const agent = {
    readyState,
    shouldReconnect,
    send: (data: unknown) => {
      sent.push(data);
      return true;
    },
  };
  return { guarded: guardResumeProbe(agent), sent };
}

describe("guardResumeProbe — drop the undeliverable stream-resume probe", () => {
  it("drops the probe on a CLOSED socket that will not reconnect", () => {
    const { guarded, sent } = socket(3, false);
    expect(guarded.send(PROBE)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("drops the probe on a CONNECTING socket that will not reconnect", () => {
    const { guarded, sent } = socket(0, false);
    expect(guarded.send(PROBE)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("keeps the probe when the socket will reconnect (buffered retry path)", () => {
    const connecting = socket(0, true);
    expect(connecting.guarded.send(PROBE)).toBe(true);
    expect(connecting.sent).toEqual([PROBE]);

    const closed = socket(3, true);
    expect(closed.guarded.send(PROBE)).toBe(true);
    expect(closed.sent).toEqual([PROBE]);
  });

  it("passes every non-probe payload through untouched", () => {
    const { guarded, sent } = socket(0, false);
    expect(guarded.send("hello")).toBe(true);
    expect(guarded.send(JSON.stringify({ type: "cf_agent_other" }))).toBe(true);
    expect(sent).toHaveLength(2);
  });
});
