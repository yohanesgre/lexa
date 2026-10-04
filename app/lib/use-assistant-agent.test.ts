// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resumeOutcome } from "./use-assistant-agent";

// LX-84: the resume POST must be treated as succeeded only on an explicit JSON
// `{ok:true}`; a non-JSON 2xx is the legacy SSE path and falls back to r.ok.
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
  it("accepts an explicit JSON {ok:true}", async () => {
    await expect(resumeOutcome(jsonResponse({ ok: true }))).resolves.toBe(true);
  });

  it("rejects a JSON body without ok:true even on a 2xx", async () => {
    await expect(resumeOutcome(jsonResponse({ ok: false }))).resolves.toBe(false);
    await expect(resumeOutcome(jsonResponse({}))).resolves.toBe(false);
    await expect(resumeOutcome(jsonResponse({ ok: "yes" }))).resolves.toBe(false);
  });

  it("rejects a malformed JSON body", async () => {
    const res = {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response;
    await expect(resumeOutcome(res)).resolves.toBe(false);
  });

  it("falls back to r.ok for a non-JSON response (legacy SSE path)", async () => {
    await expect(resumeOutcome(textResponse(true))).resolves.toBe(true);
    await expect(resumeOutcome(textResponse(false))).resolves.toBe(false);
  });
});
