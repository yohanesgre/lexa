import { describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "@tanstack/ai";
import type { StreamFrame } from "../../shared/assistant";
import { buildStream, normalizeRunUsage, reconcilePendingBatchStatuses, sanitizeProviderMessages, type StreamRunContext } from "./build-stream";
import { MAX_CHAT_TOOL_ROUNDS } from "./tools";
import type { QueuedProposal } from "./write-tools";

vi.mock("./provider", () => ({
  streamChat: async function* () {
    throw new Error("unexpected direct streamChat");
  },
  completeText: async () => {
    throw new Error("unexpected summarize call");
  },
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
});

describe("normalizeRunUsage", () => {
  const fallback = { input: 7, output: 8, cached: 1, cacheWrite: 2 };

  it("reads the TanStack object form including cache-write details", () => {
    expect(normalizeRunUsage({ promptTokens: 100, completionTokens: 40, promptTokensDetails: { cachedTokens: 30, cacheWriteTokens: 10 } }, fallback))
      .toEqual({ input: 100, output: 40, cached: 30, cacheWrite: 10 });
  });

  it("sums the AG-UI usage[] array form", () => {
    const usage = [
      { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, cacheWriteInputTokens: 5 },
      { inputTokens: 200, outputTokens: 30, cachedInputTokens: 10, cacheWriteInputTokens: 15 },
    ];
    expect(normalizeRunUsage(usage, fallback)).toEqual({ input: 300, output: 50, cached: 60, cacheWrite: 20 });
  });

  it("falls back for absent or empty usage", () => {
    expect(normalizeRunUsage(undefined, fallback)).toEqual(fallback);
    expect(normalizeRunUsage([], fallback)).toEqual(fallback);
  });
});

describe("suspendTurn persisted marker", () => {
  const proposal: QueuedProposal = {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "delete_task",
    detail: "Delete LX-1",
    diff: { type: "task_delete", taskRef: "LX-1", taskTitle: "x" },
    args: { ref: "LX-1" },
  };

  it("persists the full chip payload so a reload can rebuild decidable chips", async () => {
    let persisted: unknown[] | null = null;
    const proposalStream = () =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "" } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "delete_task" } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: JSON.stringify({ ref: "LX-1" }) } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_END", toolCallId: "call_1" } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
      })();
    const c = ctx(proposalStream);
    c.writeDrain = () => [proposal];
    c.writeTools = ["delete_task"];
    c.persist = async (messages) => {
      persisted = messages;
    };
    const frames = await drain(buildStream(c));
    expect(frames.some((f) => f.type === "suspended")).toBe(true);
    const assistantEntry = (persisted as unknown[] | null)!.find((m) => (m as { pendingBatch?: unknown }).pendingBatch !== undefined) as {
      pendingBatch: { batchId: string; approvals: Array<Record<string, unknown>> };
      toolLog?: Array<{ name: string; detail?: string }>;
    };
    expect(assistantEntry.pendingBatch.batchId).toBe("b1");
    expect(assistantEntry.pendingBatch.approvals[0]).toMatchObject({
      approvalId: "a1",
      toolCallId: "",
      seq: 0,
      name: "delete_task",
      detail: "Delete LX-1",
      diff: proposal.diff,
    });
    // The display log is persisted under `toolLog`, never the @tanstack/ai wire
    // key `toolCalls` (which would be replayed as real pending tool calls).
    expect(assistantEntry.toolLog).toHaveLength(1);
    expect(assistantEntry.toolLog![0]!.name).toBe("delete_task");
    expect(assistantEntry).not.toHaveProperty("toolCalls");
  });
});

describe("sanitizeProviderMessages", () => {
  it("strips a legacy display toolCalls log from an assistant message", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "proposed", toolCalls: [{ name: "create_task", detail: "New task" }], pendingBatch: "b1" },
    ];
    const out = sanitizeProviderMessages(messages);
    const assistant = out[1] as Record<string, unknown>;
    expect(assistant.toolCalls).toBeUndefined();
    expect(assistant.pendingBatch).toBe("b1");
    // input untouched
    expect((messages[1] as { toolCalls?: unknown }).toolCalls).toEqual([{ name: "create_task", detail: "New task" }]);
  });

  it("keeps wire-shaped toolCalls untouched", () => {
    const wire = { id: "call_1", type: "function", function: { name: "create_task", arguments: "{}" } };
    const messages = [{ role: "assistant", content: "x", toolCalls: [wire] }];
    const out = sanitizeProviderMessages(messages);
    expect(out).toBe(messages);
    expect((out[0] as { toolCalls: unknown[] }).toolCalls[0]).toBe(wire);
  });

  it("drops only the non-wire entries of a mixed array", () => {
    const wire = { id: "call_1", function: { name: "create_task", arguments: "{}" } };
    const messages = [{ role: "assistant", content: "x", toolCalls: [wire, { name: "create_task", detail: "d" }] }];
    const out = sanitizeProviderMessages(messages);
    expect((out[0] as { toolCalls: unknown[] }).toolCalls).toEqual([wire]);
  });

  it("leaves non-assistant messages and toolCalls on tool/user roles untouched", () => {
    const messages = [
      { role: "user", content: "go", toolCalls: [{ name: "x" }] },
      { role: "tool", content: "{}", toolCallId: "call_1" },
    ];
    const out = sanitizeProviderMessages(messages);
    expect(out).toBe(messages);
  });

  it("returns the input array identity when nothing needs stripping", () => {
    const messages = [{ role: "assistant", content: "hello" }];
    expect(sanitizeProviderMessages(messages)).toBe(messages);
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
});

describe("reconcilePendingBatchStatuses", () => {
  const messages = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "proposed",
      pendingBatch: {
        batchId: "b1",
        approvals: [
          { approvalId: "a1", toolCallId: "", seq: 0, name: "delete_task", diff: { type: "task_delete", taskRef: "LX-1", taskTitle: "x" } },
          { approvalId: "a2", toolCallId: "", seq: 1, name: "create_task", diff: { type: "task_create", title: "t", fields: {} } },
        ],
      },
    },
  ];

  it("applies live decision statuses from another tab", () => {
    const out = reconcilePendingBatchStatuses(messages, [
      { id: "a1", status: "approved" },
      { id: "a2", status: "rejected" },
    ]);
    const marker = out[1] as { pendingBatch: { approvals: Array<Record<string, unknown>> } };
    expect(marker.pendingBatch.approvals[0]!.status).toBe("approved");
    expect(marker.pendingBatch.approvals[1]!.status).toBe("rejected");
    // input untouched
    const original = messages[1] as { pendingBatch: { approvals: Array<Record<string, unknown>> } };
    expect(original.pendingBatch.approvals[0]!.status).toBeUndefined();
  });

  it("leaves the array identical when there are no rows", () => {
    expect(reconcilePendingBatchStatuses(messages, [])).toBe(messages);
  });

  it("ignores rows whose approval is not in the marker", () => {
    const out = reconcilePendingBatchStatuses(messages, [{ id: "other", status: "expired" }]);
    expect(out).toBe(messages);
  });

  it("backfills a legacy marker's chip payload from the decision rows", () => {
    const legacy = [
      { role: "assistant", content: "proposed", pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] } },
    ];
    const out = reconcilePendingBatchStatuses(legacy, [
      { id: "a1", status: "pending", seq: 2, name: "delete_task", diff: { type: "task_delete", taskRef: "LX-1", taskTitle: "x" } },
    ]);
    const approval = (out[0] as { pendingBatch: { approvals: Array<Record<string, unknown>> } }).pendingBatch.approvals[0]!;
    expect(approval).toMatchObject({
      approvalId: "a1",
      toolCallId: "call_1",
      seq: 2,
      name: "delete_task",
      status: "pending",
      diff: { type: "task_delete", taskRef: "LX-1", taskTitle: "x" },
    });
  });
});
