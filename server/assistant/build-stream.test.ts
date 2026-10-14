import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "@tanstack/ai";
import type { StreamFrame } from "../../shared/assistant";
import { buildStream, buildResumeResultsNote, findNewestPendingBatch, pendingBatchIdsNewestFirst, isWriteIntentClaim, normalizeProviderMessages, normalizeRunUsage, reconcilePendingBatchStatuses, sanitizeProviderMessages, type StreamRunContext } from "./build-stream";
import { MAX_CHAT_TOOL_ROUNDS } from "./tools";
import { buildAutoWriteRecord, buildTaskCreateDiff, createLocalWriteTracker, createWriteRecorder, type QueuedProposal } from "./write-tools";

const providerMocks = vi.hoisted(() => ({
  completeText: vi.fn<() => Promise<string>>(async () => { throw new Error("unexpected summarize call"); }),
}));

vi.mock("./provider", () => ({
  streamChat: async function* () {
    throw new Error("unexpected direct streamChat");
  },
  completeText: providerMocks.completeText,
  translateRunError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  clientFacingErrorMessage: (err: unknown) => (err instanceof Error ? err.message : "Assistant generation failed"),
}));

async function drain(stream: ReadableStream<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function ctx(
  gatewayStream: (input: unknown) => AsyncIterable<StreamChunk>,
  hooks: Partial<Pick<StreamRunContext, "onDone" | "onFail" | "onCancel" | "onDispose">> = {}
): StreamRunContext {
  return {
    keyId: "c1",
    idField: "chatId",
    threadId: "c1",
    registry: new Map(),
    config: { kind: "openai_compatible", baseUrl: "https://x.test", apiKey: "k", model: "m" },
    systemPrompts: [],
    history: [],
    userTs: "2026-09-27T00:00:00Z",
    getCitations: () => [],
    userContent: "hi",
    tools: [],
    toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
    loadImageBase64: async () => null,
    imageMode: "inline",
    historySummary: () => null,
    historySummarizedCount: () => 0,
    persist: async () => {},
    onDone: async () => {},
    onFail: async () => {},
    onCancel: async () => {},
    gatewayStream,
    ...hooks,
  };
}

const doneStream = () =>
  (async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" } as unknown as StreamChunk;
    yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
  })();

function autoWriteCtx(output: unknown, answer = "Created a task.", state?: string): StreamRunContext {
  const c = ctx(() =>
    (async function* () {
      yield { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "create_task" } as unknown as StreamChunk;
      yield { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"title":"New task"}' } as unknown as StreamChunk;
      yield { type: "TOOL_CALL_END", toolCallId: "call-1" } as unknown as StreamChunk;
      yield { type: "TOOL_CALL_RESULT", toolCallId: "call-1", messageId: "call-1", content: JSON.stringify(output), role: "tool", ...(state !== undefined ? { metadata: { tanstack: { state } } } : {}) } as unknown as StreamChunk;
      yield { type: "TEXT_MESSAGE_CONTENT", delta: answer } as unknown as StreamChunk;
      yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
    })()
  );
  c.userContent = "Create a task called New task";
  c.writeTools = ["create_task"];
  c.writeMode = "auto";
  return c;
}
describe("buildStream onDispose", () => {
  it("disposes exactly once on the done path", async () => {
    let disposed = 0;
    const frames = await drain(buildStream(ctx(doneStream, { onDispose: async () => { disposed += 1; } })));
    expect(frames.at(-1)?.type).toBe("done");
    expect(disposed).toBe(1);
  });

  it("disposes exactly once on the fail path", async () => {
    let disposed = 0;
    let failed = 0;
    const failing = () =>
      (async function* () {
        throw new Error("provider exploded");
      })();
    const frames = await drain(buildStream(ctx(failing, { onDispose: async () => { disposed += 1; }, onFail: async () => { failed += 1; } })));
    expect(frames.some((f) => f.type === "error")).toBe(true);
    expect(failed).toBe(1);
    expect(disposed).toBe(1);
  });

  it("disposes exactly once on the cancel path", async () => {
    let disposed = 0;
    let cancelled = 0;
    const c = ctx(() => (async function* () {})());
    c.gatewayStream = () => {
      c.registry.get("c1")?.abort();
      return (async function* () {
        throw new Error("aborted");
      })();
    };
    c.onDispose = async () => { disposed += 1; };
    c.onCancel = async () => { cancelled += 1; };
    await drain(buildStream(c));
    expect(cancelled).toBe(1);
    expect(disposed).toBe(1);
  });

  it("late cancellation cannot abort or remove a newer run for the same key", async () => {
    const finishing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disposed = Promise.withResolvers<void>();
    const c = ctx(doneStream, {
      onDone: async () => { finishing.resolve(); await release.promise; },
      onDispose: async () => { disposed.resolve(); },
    });
    const stream = buildStream(c);
    const prior = c.registry.get(c.keyId)!;
    const reader = stream.getReader();
    await finishing.promise;
    const newer = new AbortController();
    c.registry.set(c.keyId, newer);
    await reader.cancel();
    release.resolve();
    await disposed.promise;
    expect(prior.signal.aborted).toBe(true);
    expect(newer.signal.aborted).toBe(false);
    expect(c.registry.get(c.keyId)).toBe(newer);
  });
});
describe("buildStream local write quiescence", () => {
  it("waits for a deferred recorder insert, persists its proposal, then releases run ownership", async () => {
    const tracker = createLocalWriteTracker();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inserted: string[] = [];
    const persisted: Array<Array<Record<string, unknown>>> = [];
    let disposed = false;
    const recorder = createWriteRecorder(
      { projectId: "p", documentType: "chat", documentId: "c1", ownerUserId: "u" },
      async (row) => { started.resolve(); await release.promise; inserted.push(row.id); }
    );
    let c!: StreamRunContext;
    c = ctx(() =>
      (async function* () {
        yield { type: "TOOL_CALL_START", toolCallId: "call-late", toolCallName: "create_task" } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_ARGS", toolCallId: "call-late", delta: '{"title":"Late task"}' } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_END", toolCallId: "call-late" } as unknown as StreamChunk;
        const result = await tracker.run(c.registry.get(c.keyId)?.signal, "call-late", "create_task", () =>
          recorder.record({ name: "create_task", args: { title: "Late task" }, diff: buildTaskCreateDiff({ title: "Late task" }) })
        );
        yield { type: "TOOL_CALL_RESULT", toolCallId: "call-late", content: JSON.stringify(result), role: "tool" } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
      })()
    );
    c.localWriteTracker = tracker;
    c.writeMode = "ask";
    c.writeDrain = () => recorder.drain();
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    c.onDispose = async () => { disposed = true; };

    const reader = buildStream(c).getReader();
    expect((await reader.read()).value?.type).toBe("start");
    await reader.read();
    await reader.read();
    await started.promise;
    const prior = c.registry.get(c.keyId)!;
    const terminal = reader.read();
    prior.abort();
    let startsAfterStop = 0;
    await tracker.run(prior.signal, "call-after-stop", "create_task", async () => { startsAfterStop += 1; return recorder.record({ name: "create_task", args: { title: "Forbidden" }, diff: buildTaskCreateDiff({ title: "Forbidden" }) }); });
    await Promise.resolve();
    expect(c.registry.get(c.keyId)).toBe(prior);
    expect(disposed).toBe(false);
    expect(inserted).toEqual([]);
    expect(startsAfterStop).toBe(0);

    release.resolve();
    const frames = [await terminal];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      frames.push(next);
    }
    expect(frames.some((frame) => frame.value?.type === "suspended")).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(persisted.at(-1)!.at(-1)!.pendingBatch).toMatchObject({
      approvals: [{ approvalId: inserted[0], toolCallId: "call-late" }],
    });
    expect(disposed).toBe(true);
    expect(c.registry.has(c.keyId)).toBe(false);

    const next = buildStream({ ...c, gatewayStream: doneStream, onDispose: undefined });
    const nextReader = next.getReader();
    expect((await nextReader.read()).value?.type).toBe("start");
    expect(c.registry.get(c.keyId)).not.toBe(prior);
    await nextReader.cancel();
  });

  it("waits for deferred Auto apply and persists stopped canonical tool activity", async () => {
    const tracker = createLocalWriteTracker();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const persisted: Array<Array<Record<string, unknown>>> = [];
    let applied = 0;
    const record = buildAutoWriteRecord({
      apply: async () => { applied += 1; started.resolve(); await release.promise; return { ok: true, result: { id: "task-1" } }; },
    });
    let c!: StreamRunContext;
    c = ctx(() =>
      (async function* () {
        yield { type: "TOOL_CALL_START", toolCallId: "call-auto", toolCallName: "create_task" } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_ARGS", toolCallId: "call-auto", delta: '{"title":"Auto task"}' } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_END", toolCallId: "call-auto" } as unknown as StreamChunk;
        const result = await tracker.run(c.registry.get(c.keyId)?.signal, "call-auto", "create_task", () =>
          record({ name: "create_task", args: { title: "Auto task" }, diff: buildTaskCreateDiff({ title: "Auto task" }) })
        );
        yield { type: "TOOL_CALL_RESULT", toolCallId: "call-auto", content: JSON.stringify(result), role: "tool" } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
      })()
    );
    c.localWriteTracker = tracker;
    c.writeMode = "auto";
    c.writeTools = ["create_task"];
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    const draining = drain(buildStream(c));
    await started.promise;
    const controller = c.registry.get(c.keyId)!;
    controller.abort();
    await Promise.resolve();
    expect(c.registry.get(c.keyId)).toBe(controller);
    expect(applied).toBe(1);
    release.resolve();
    const frames = await draining;
    expect(frames.some((frame) => frame.type === "done")).toBe(false);
    expect(persisted.at(-1)!.at(-1)).toMatchObject({
      stopped: true,
      toolLog: [{ name: "create_task" }],
    });
  });
});
describe("buildStream bounds (M1 turn budget, M2 output cap)", () => {
  it("ends a trickling turn at the turn budget instead of streaming forever", async () => {
    vi.useFakeTimers();
    try {
      const persisted: Array<Array<Record<string, unknown>>> = [];
      // One reasoning delta, then the provider hangs. Every IDLE bound (the 90s
      // stall) resets on each chunk, so only the turn-wide deadline can end a
      // turn whose stream keeps producing — that is the defect this bound fixes.
      const c = ctx(() =>
        (async function* () {
          yield { type: "REASONING_MESSAGE_CONTENT", delta: "think" } as unknown as StreamChunk;
          await new Promise<never>(() => {});
        })()
      );
      c.turnBudgetMs = 40;
      c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };

      const pending = drain(buildStream(c));
      await vi.advanceTimersByTimeAsync(100);
      const frames = await pending;
      const terminal = frames.at(-1);
      expect(terminal?.type).toBe("error");
      expect((terminal as { code: string }).code).toBe("ASSISTANT_GENERATION_FAILED");
      const assistant = persisted.at(-1)!.at(-1)!;
      expect(assistant.error).toMatchObject({ code: "ASSISTANT_GENERATION_FAILED" });
      // The partial turn is still persisted — a bound never loses the turn.
      expect(assistant.reasoning).toBe("think");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a visible failure when the last provider response was cut at the output cap", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const c = ctx(() =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "partial repl" } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED", finishReason: "length" } as unknown as StreamChunk;
      })()
    );
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };

    const frames = await drain(buildStream(c));
    const terminal = frames.at(-1);
    expect(terminal?.type).toBe("error");
    const assistant = persisted.at(-1)!.at(-1)!;
    expect(assistant.content).toBe("partial repl");
    expect(assistant.error).toMatchObject({ code: "ASSISTANT_GENERATION_FAILED" });
  });

  it("keeps a turn that finished on `stop` on the done path", async () => {
    const c = ctx(() =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "complete reply" } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED", finishReason: "stop" } as unknown as StreamChunk;
      })()
    );
    const frames = await drain(buildStream(c));
    expect(frames.at(-1)?.type).toBe("done");
  });
  it("fails an EOF without RUN_FINISHED and retains visible partial text", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const c = ctx(() =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "partial answer" } as unknown as StreamChunk;
      })()
    );
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };

    const frames = await drain(buildStream(c));
    expect(frames.at(-1)?.type).toBe("error");
    expect(frames.some((frame) => frame.type === "done")).toBe(false);
    const assistant = persisted.at(-1)!.at(-1)!;
    expect(assistant.content).toBe("partial answer");
    expect(assistant.error).toMatchObject({ code: "ASSISTANT_GENERATION_FAILED" });
  });
});

describe("buildStream provider-boundary sanitization", () => {
  it("never hands a legacy display toolCalls log to the provider", async () => {
    let seen: Array<Record<string, unknown>> | null = null;
    const c = ctx((input: unknown) => {
      seen = (input as { messages: Array<Record<string, unknown>> }).messages;
      return doneStream();
    });
    c.history = [
      { role: "user", content: "go" },
      { role: "assistant", content: "proposed", toolCalls: [{ name: "create_task", detail: "New task" }] },
    ];
    const frames = await drain(buildStream(c));
    expect(frames.at(-1)?.type).toBe("done");
    const assistant = seen!.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls).toBeUndefined();
  });

  it("normalizes a parts-shaped (DO mirror) transcript so no user message is empty and the text survives", async () => {
    let seen: Array<Record<string, unknown>> | null = null;
    const c = ctx((input: unknown) => {
      seen = (input as { messages: Array<Record<string, unknown>> }).messages;
      return doneStream();
    });
    c.skipUserEntry = true;
    c.resumeResultsNote = '[approved write results]\n- create_task "New task" [EG-2]: applied';
    c.history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "create a task called New task" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "text", text: "Shall I go ahead?" },
          { type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } },
          { type: "tool-create_task", toolCallId: "call_1", state: "output-available", output: "{}" },
        ],
      },
    ];
    const frames = await drain(buildStream(c));
    expect(frames.at(-1)?.type).toBe("done");

    expect(seen!.every((m) => !Array.isArray(m.parts))).toBe(true);
    expect(seen!.some((m) => m.role === "user" && String(m.content).trim() === "")).toBe(false);
    expect(seen).toContainEqual({ role: "user", content: "create a task called New task" });
    expect(seen).toContainEqual({ role: "assistant", content: "Shall I go ahead?" });

    const note = seen!.find((m) => m.role === "user" && String(m.content).includes("[approved write results]"))!;
    expect(typeof note.content).toBe("string");
    expect(String(note.content)).toContain("[EG-2]");
  });

  it("leaves a legacy (Bun) content-shaped transcript unchanged", async () => {
    let seen: Array<Record<string, unknown>> | null = null;
    const c = ctx((input: unknown) => {
      seen = (input as { messages: Array<Record<string, unknown>> }).messages;
      return doneStream();
    });
    c.skipUserEntry = true;
    const history = [{ role: "user", content: "legacy prompt" }, { role: "assistant", content: "legacy reply" }];
    c.history = history;
    await drain(buildStream(c));
    expect(seen![0]).toEqual(history[0]);
    expect(seen![1]).toEqual(history[1]);
  });
});

describe("buildStream actual auto-write outcomes", () => {
  // Contract A8: a recorded auto-write success proves changes occurred even without an ask-mode drain.
  it("preserves a success claim when the stored auto-write result applied", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const c = autoWriteCtx({ ok: true, applied: true, result: { id: "t1" } });
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    const frames = await drain(buildStream(c));
    expect(frames.at(-1)?.type).toBe("done");
    expect(persisted.at(-1)!.at(-1)!.content).toBe("Created a task.");
  });

  // Contract A8: an authoritative failed result overrides a success claim.
  it("does not retain a success claim after a failed auto-write result", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const c = autoWriteCtx({ proposed: false, error: "write failed" });
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    await drain(buildStream(c));
    expect(persisted.at(-1)!.at(-1)!.content).not.toBe("Created a task.");
  });
  it("does not treat a conflicting output-error as proof of applied writes", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const c = autoWriteCtx({ ok: true, applied: true, result: { id: "t1" } }, "Created a task.", "output-error");
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    const frames = await drain(buildStream(c));
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "ASSISTANT_GENERATION_FAILED" });
    expect(persisted.at(-1)!.at(-1)!.error).toMatchObject({ code: "ASSISTANT_GENERATION_FAILED" });
    expect(persisted.at(-1)!.at(-1)!.toolLog).toEqual([{ name: "create_task" }]);
  });

  // Contract A8: partial applied results are not rewritten as proof of no changes.
  it("preserves the actual partial outcome", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    const answer = "One change applied; another failed.";
    const c = autoWriteCtx({ ok: false, applied: false, error: "one item failed", partial: { applied: ["t1"], failed: ["t2"] } }, answer);
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    await drain(buildStream(c));
    expect(persisted.at(-1)!.at(-1)!.content).toBe(answer);
  });
});

describe("buildStream compaction provider resolution", () => {
  // Contract A5: compaction uses the resolved provider config; failure preserves the unsummarized transcript.
  it("keeps complete history when compaction fails after config resolution", async () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];
    let resolved = 0;
    const c = ctx(doneStream);
    c.history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `history-${i}` }));
    c.resolveCompactionConfig = async () => {
      resolved += 1;
      return { kind: "openai_compatible", baseUrl: "https://resolved.test/v1", apiKey: "resolved-key", model: "resolved-model" };
    };
    c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
    await drain(buildStream(c));
    expect(resolved).toBe(1);
    expect(persisted.at(-1)).toHaveLength(42);
    expect(persisted.at(-1)!.some((message) => message.content === "history-0")).toBe(true);
  });
});
describe("buildStream compaction cancellation", () => {
  it("stops deferred summary completion and preserves the complete history", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const persisted: Array<Array<Record<string, unknown>>> = [];
    providerMocks.completeText.mockImplementation(() => { started.resolve(); return release.promise; });
    try {
      const c = ctx(doneStream);
      c.history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `history-${i}` }));
      c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
      const framesPromise = drain(buildStream(c));
      await started.promise;
      c.registry.get(c.keyId)!.abort();
      const frames = await framesPromise;
      expect(frames.at(-1)?.type).not.toBe("done");
      expect(persisted.at(-1)!.some((message) => message.content === "history-0")).toBe(true);
      expect(persisted.at(-1)!.at(-1)).toMatchObject({ stopped: true });
    } finally {
      release.resolve("late summary");
      providerMocks.completeText.mockRejectedValue(new Error("unexpected summarize call"));
    }
  });

  it("bounds a deferred summary by the turn deadline without trimming history", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const persisted: Array<Array<Record<string, unknown>>> = [];
    providerMocks.completeText.mockImplementation(() => { started.resolve(); return release.promise; });
    try {
      const c = ctx(doneStream);
      c.turnBudgetMs = 25;
      c.history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `history-${i}` }));
      c.resolveCompactionConfig = async () => c.config;
      c.persist = async (messages) => { persisted.push(messages as Array<Record<string, unknown>>); };
      const framesPromise = drain(buildStream(c));
      await started.promise;
      await vi.advanceTimersByTimeAsync(30);
      const frames = await framesPromise;
      expect(frames.at(-1)?.type).toBe("error");
      expect(persisted.at(-1)!.some((message) => message.content === "history-0")).toBe(true);
      expect(persisted.at(-1)!.at(-1)!.error).toMatchObject({ code: "ASSISTANT_GENERATION_FAILED" });
    } finally {
      release.resolve("late summary");
      providerMocks.completeText.mockRejectedValue(new Error("unexpected summarize call"));
      vi.useRealTimers();
    }
  });
});
