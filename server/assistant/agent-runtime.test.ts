import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_LEGACY_PATH,
  INTERNAL_MIRROR_PATH,
  AssistantInternalUnavailable,
  fetchLegacyTranscript,
  mirrorTranscript,
  type FetchLike,
} from "./agent-runtime";
import {
  INTERNAL_AUTH_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";

const SECRET = "runtime-master-key-0123456789";
const IDENTITY: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: "chat:abc" };
const NOW_MS = 1_700_000_000_000;

function deps(fetchImpl: FetchLike) {
  return { origin: "https://lexa.test/", identity: IDENTITY, masterKey: SECRET, fetchImpl, nowMs: () => NOW_MS };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchLegacyTranscript", () => {
  it("reads the D1 transcript over the signed internal route and converts it", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: new Headers(init?.headers) });
      return jsonResponse({
        messages: [
          { role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" },
          { role: "assistant", content: "hi", ts: "2026-01-01T00:00:01.000Z" },
        ],
      });
    };

    const converted = await fetchLegacyTranscript(deps(fetchImpl));

    expect(calls[0]?.url).toBe(`https://lexa.test${INTERNAL_LEGACY_PATH}/chat%3Aabc`);
    const headers = calls[0]!.headers;
    expect(headers.get(INTERNAL_AUTH_THREAD_HEADER)).toBe("chat:abc");
    await expect(
      verifyInternalAuth(SECRET, headers.get(INTERNAL_AUTH_HEADER), IDENTITY, { nowMs: NOW_MS })
    ).resolves.toBe(true);
    expect(converted).toEqual([
      { id: "legacy-0", role: "user", parts: [{ type: "text", text: "hello" }], metadata: { ts: "2026-01-01T00:00:00.000Z" } },
      { id: "legacy-1", role: "assistant", parts: [{ type: "text", text: "hi" }], metadata: { ts: "2026-01-01T00:00:01.000Z" } },
    ]);
  });

  it("returns null when the thread has no legacy D1 row (404)", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: "ASSISTANT_THREAD_NOT_FOUND" } }, 404);
    await expect(fetchLegacyTranscript(deps(fetchImpl))).resolves.toBeNull();
  });

  it("retries once and succeeds when the first attempt fails", async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return n === 1 ? jsonResponse({}, 500) : jsonResponse({ messages: [{ role: "user", content: "x" }] });
    };
    const converted = await fetchLegacyTranscript(deps(fetchImpl));
    expect(n).toBe(2);
    expect(converted?.[0]?.parts).toEqual([{ type: "text", text: "x" }]);
  });

  it("throws AssistantInternalUnavailable after the retry-once policy fails", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(fetchLegacyTranscript(deps(fetchImpl))).rejects.toBeInstanceOf(AssistantInternalUnavailable);
  });
});

describe("mirrorTranscript", () => {
  it("POSTs the transcript envelope with a signed identity", async () => {
    const calls: Array<{ url: string; method?: string | undefined; headers: Headers; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ ok: true });
    };

    const ok = await mirrorTranscript(deps(fetchImpl), {
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      summary: null,
      summarizedCount: null,
      title: null,
    });

    expect(ok).toBe(true);
    expect(calls[0]?.url).toBe(`https://lexa.test${INTERNAL_MIRROR_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      threadKey: "chat:abc",
      projectId: "proj-1",
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      summary: null,
      // The DO sends null until the P3 engine tracks summary state; the mirror
      // COALESCEs, so a literal 0 must never be sent.
      summarizedCount: null,
      title: null,
    });
  });

  it("forwards a real summarizedCount when the engine supplies one", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ ok: true });
    };
    await mirrorTranscript(deps(fetchImpl), { messages: [], summary: "s", summarizedCount: 3 });
    expect((bodies[0] as { summarizedCount: number }).summarizedCount).toBe(3);
  });

  it("retries once then reports failure without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return jsonResponse({}, 502);
    };
    await expect(mirrorTranscript(deps(fetchImpl), { messages: [], summary: null, summarizedCount: 0 })).resolves.toBe(false);
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retries once and succeeds when the first mirror attempt fails", async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return n === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true });
    };
    await expect(mirrorTranscript(deps(fetchImpl), { messages: [], summary: null, summarizedCount: 0 })).resolves.toBe(true);
    expect(n).toBe(2);
  });
});
