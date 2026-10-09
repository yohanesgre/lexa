import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_LEGACY_PATH,
  INTERNAL_MIRROR_PATH,
  INTERNAL_RESUME_EXECUTE_PATH,
  INTERNAL_TURN_CONTEXT_PATH,
  INTERNAL_WRITE_EXECUTE_PATH,
  AssistantInternalUnavailable,
  callWriteExecute,
  executeResumeBatchRemote,
  fetchLegacyTranscript,
  mirrorTranscript,
  resolveHarnessContext,
  type FetchLike,
} from "./agent-runtime";
import type { HarnessTurnContext } from "./internal-routes";
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

describe("callWriteExecute (auto mode)", () => {
  const INPUT = { name: "update_task", args: { ref: "P-1", title: "x" }, projectId: "proj-1", ownerUserId: "user-1" };

  it("POSTs the write to the execute route and maps an applied result", async () => {
    const calls: Array<{ url: string; method?: string | undefined; headers: Headers; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true, applied: true, result: { id: "t1" } });
    };
    const out = await callWriteExecute(deps(fetchImpl), INPUT);
    expect(out).toEqual({ ok: true, applied: true, result: { id: "t1" } });
    expect(calls[0]?.url).toBe(`https://lexa.test${INTERNAL_WRITE_EXECUTE_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual(INPUT);
    const headers = calls[0]!.headers;
    await expect(
      verifyInternalAuth(SECRET, headers.get(INTERNAL_AUTH_HEADER), IDENTITY, { nowMs: NOW_MS })
    ).resolves.toBe(true);
  });

  it("preserves a partial batch count on an applied result", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ ok: true, applied: true, result: { applied: ["P-1"], failed: [] }, partial: { applied: 1, failed: 1, errors: ["x"] } });
    const out = await callWriteExecute(deps(fetchImpl), INPUT);
    expect(out).toEqual({
      ok: true,
      applied: true,
      result: { applied: ["P-1"], failed: [] },
      partial: { applied: 1, failed: 1, errors: ["x"] },
    });
  });

  it("maps a zero-applied failure to a typed error the model reads", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ ok: false, applied: false, error: "TASK_NOT_FOUND: nope" });
    await expect(callWriteExecute(deps(fetchImpl), INPUT)).resolves.toEqual({ ok: false, applied: false, error: "TASK_NOT_FOUND: nope" });
  });

  it("does NOT retry a failed write (a lost response must not double-apply)", async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      throw new Error("network down");
    };
    await expect(callWriteExecute(deps(fetchImpl), INPUT)).resolves.toMatchObject({ ok: false, applied: false });
    expect(n).toBe(1);
  });

  it("marks a transport failure indeterminate (may have applied — do not retry)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const out = await callWriteExecute(deps(fetchImpl), INPUT);
    expect(out).toMatchObject({ ok: false, applied: false, indeterminate: true });
    expect((out as { error?: string }).error).toContain("may have applied");
  });

  it("marks a non-2xx route failure indeterminate too", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: "ASSISTANT_UNAVAILABLE" } }, 502);
    const out = await callWriteExecute(deps(fetchImpl), INPUT);
    expect(out).toMatchObject({ ok: false, applied: false, indeterminate: true });
  });

  it("does NOT mark a Worker-decided failure indeterminate", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ ok: false, applied: false, error: "TASK_NOT_FOUND: nope" });
    const out = await callWriteExecute(deps(fetchImpl), INPUT);
    expect(out).toEqual({ ok: false, applied: false, error: "TASK_NOT_FOUND: nope" });
    expect((out as { indeterminate?: unknown }).indeterminate).toBeUndefined();
  });
});

describe("executeResumeBatchRemote", () => {
  it("POSTs the batch id to the resume-execute route with a signed identity", async () => {
    const calls: Array<{ url: string; method?: string | undefined; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({ ok: true, note: "done" });
    };
    await executeResumeBatchRemote(deps(fetchImpl), "batch-1");
    expect(calls[0]?.url).toBe(`https://lexa.test${INTERNAL_RESUME_EXECUTE_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ batchId: "batch-1" });
  });

  it("maps an AbortError (timeout) to unavailable so the DO keeps its claim", async () => {
    // `AbortSignal.timeout` rejects with an AbortError; the mapping must be
    // `unavailable` (writes MAY have applied → never retry), not a thrown error.
    const fetchImpl: FetchLike = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    await expect(executeResumeBatchRemote(deps(fetchImpl), "batch-1")).resolves.toEqual({ kind: "unavailable" });
  });

  it("maps a non-ok response to unavailable", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ error: { code: "ASSISTANT_UNAVAILABLE" } }, 502);
    await expect(executeResumeBatchRemote(deps(fetchImpl), "batch-1")).resolves.toEqual({ kind: "unavailable" });
  });

  it("maps the discriminated body to executed/pending/noop/missing/unsupported", async () => {
    const withBody = (b: unknown): FetchLike => async () => jsonResponse(b);
    await expect(executeResumeBatchRemote(deps(withBody({ ok: true, note: "n" })), "b1")).resolves.toEqual({
      kind: "executed",
      note: "n",
    });
    await expect(
      executeResumeBatchRemote(deps(withBody({ ok: false, reason: "pending", remaining: 2 })), "b1")
    ).resolves.toEqual({ kind: "pending", remaining: 2 });
    await expect(executeResumeBatchRemote(deps(withBody({ ok: false, reason: "noop" })), "b1")).resolves.toEqual({
      kind: "noop",
      note: "",
    });
    await expect(
      executeResumeBatchRemote(
        deps(withBody({ ok: false, reason: "noop", note: '[approved write results]\n- update_task "P-1": rejected (not executed)' })),
        "b1"
      )
    ).resolves.toEqual({
      kind: "noop",
      note: '[approved write results]\n- update_task "P-1": rejected (not executed)',
    });
    await expect(executeResumeBatchRemote(deps(withBody({ ok: false, reason: "missing" })), "b1")).resolves.toEqual({
      kind: "missing",
    });
    // LX-116: a non-chat thread is `unsupported` (not `missing`/`unavailable`),
    // so the DO releases its claim instead of stranding the batch.
    await expect(
      executeResumeBatchRemote(deps(withBody({ ok: false, reason: "unsupported" })), "b1")
    ).resolves.toEqual({ kind: "unsupported" });
  });
});

const CONTEXT: HarnessTurnContext = {
  projectId: "proj-1",
  threadKey: "chat:abc",
  documentType: "chat",
  agent: null,
  skillMarkdowns: [],
  skillCatalog: null,
  memoryBlock: null,
  docContext: null,
  repoContent: [],
  mentionContext: null,
  advisory: null,
  threadSummary: null,
  readTools: ["get_task"],
  mcpTools: [],
  writeTools: [],
  primarySupportsImages: false,
  visionModel: null,
  hasSearchKey: false,
  jevConfigured: false,
  delegation: { enabled: false, maxConcurrentRuns: 0 },
};

describe("resolveHarnessContext", () => {
  it("POSTs the turn request with a signed identity and maps the context", async () => {
    const calls: Array<{ url: string; method?: string | undefined; headers: Headers; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        method: init?.method,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ context: CONTEXT });
    };

    const out = await resolveHarnessContext(deps(fetchImpl), {
      threadKey: "chat:spoofed",
      runId: "run-7",
      userText: "hi",
      mode: "turn",
    });

    expect(out).toEqual(CONTEXT);
    expect(calls[0]?.url).toBe(`https://lexa.test${INTERNAL_TURN_CONTEXT_PATH}`);
    expect(calls[0]?.method).toBe("POST");
    // The signed identity's thread wins over the request body; no projectId on
    // the wire at all.
    expect(calls[0]?.body).toEqual({ threadKey: "chat:abc", runId: "run-7", userText: "hi", mode: "turn" });
    const headers = calls[0]!.headers;
    await expect(
      verifyInternalAuth(SECRET, headers.get(INTERNAL_AUTH_HEADER), IDENTITY, { nowMs: NOW_MS })
    ).resolves.toBe(true);
  });

  it("omits runId when not supplied", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ context: CONTEXT });
    };
    await resolveHarnessContext(deps(fetchImpl), { threadKey: "chat:abc", userText: "hi", mode: "resume" });
    expect(bodies[0]).toEqual({ threadKey: "chat:abc", userText: "hi", mode: "resume" });
  });

  it("returns null on a non-ok or malformed response", async () => {
    const notOk: FetchLike = async () => jsonResponse({}, 502);
    await expect(
      resolveHarnessContext(deps(notOk), { threadKey: "chat:abc", userText: "hi", mode: "turn" })
    ).resolves.toBeNull();
    const malformed: FetchLike = async () => jsonResponse({ context: { readTools: "nope" } });
    await expect(
      resolveHarnessContext(deps(malformed), { threadKey: "chat:abc", userText: "hi", mode: "turn" })
    ).resolves.toBeNull();
  });

  it("returns null when the transport throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(
      resolveHarnessContext(deps(boom), { threadKey: "chat:abc", userText: "hi", mode: "turn" })
    ).resolves.toBeNull();
  });
});
