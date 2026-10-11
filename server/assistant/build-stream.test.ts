import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "@tanstack/ai";
import type { StreamFrame } from "../../shared/assistant";
import { buildStream, buildResumeResultsNote, findNewestPendingBatch, pendingBatchIdsNewestFirst, isWriteIntentClaim, normalizeProviderMessages, normalizeRunUsage, reconcilePendingBatchStatuses, sanitizeProviderMessages, WRITE_NOT_EXECUTED_COPY, type StreamRunContext } from "./build-stream";
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
