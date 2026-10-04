import { describe, expect, it } from "vitest";
import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from "ai";
import type { AssistantWriteDiff } from "../../shared/assistant";
import {
  agentSendMetadata,
  agentSendParts,
  agentToolLabel,
  emptyAgentSegment,
  hasUserMessage,
  lastAssistantMessage,
  reasoningMsFromMessage,
  segmentFromAssistantMessage,
  segmentFromMessages,
  snapshotFromSegment,
  statusFromChat,
  suspensionFromMessages,
  usageFromMessage,
} from "./assistant-agent-adapter";

// ADR-0003 P4b (WS1): pure adapter tests. No React, no transport — every case
// builds a UIMessage from the AI SDK part shapes and asserts the legacy
// `AssistantStreamSnapshot` projection the transcript renderers consume.

type Part = UIMessagePart<UIDataTypes, UITools>;

const DIFF = { type: "task_create", title: "New task", fields: {} } as unknown as AssistantWriteDiff;

function assistant(parts: Part[], metadata?: unknown): UIMessage {
  return { id: "m1", role: "assistant", parts, ...(metadata !== undefined ? { metadata } : {}) } as unknown as UIMessage;
}

function user(text: string): UIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] as Part[] } as unknown as UIMessage;
}

function text(value: string): Part {
  return { type: "text", text: value } as Part;
}

function reasoning(value: string): Part {
  return { type: "reasoning", text: value } as Part;
}

function sourceUrl(url: string, title?: string): Part {
  return { type: "source-url", sourceId: "s1", url, ...(title !== undefined ? { title } : {}) } as unknown as Part;
}

function dataPart(name: string, data: unknown): Part {
  return { type: `data-${name}`, data } as unknown as Part;
}

function toolCall(name: string, toolCallId: string, input?: unknown): Part {
  return { type: `tool-${name}`, toolCallId, state: "input-available", input: input ?? {} } as unknown as Part;
}

function toolResult(name: string, toolCallId: string, input: unknown, output: unknown): Part {
  return { type: `tool-${name}`, toolCallId, state: "output-available", input, output } as unknown as Part;
}

function toolError(name: string, toolCallId: string, input: unknown, errorText: string): Part {
  return { type: `tool-${name}`, toolCallId, state: "output-error", input, errorText } as unknown as Part;
}

function dynamicTool(name: string, toolCallId: string, state: "input-streaming" | "input-available"): Part {
  return { type: "dynamic-tool", toolName: name, toolCallId, state, ...(state === "input-available" ? { input: {} } : {}) } as unknown as Part;
}

describe("agentToolLabel", () => {
  it("maps the wireframe tool names to chip copy", () => {
    expect(agentToolLabel("web_search")).toBe("Searching web…");
    expect(agentToolLabel("fetch_url")).toBe("Reading file…");
    expect(agentToolLabel("read_s3_file")).toBe("Reading file…");
    expect(agentToolLabel("jev_assess")).toBe("Asking Jev…");
  });

  it("falls back to the raw tool name", () => {
    expect(agentToolLabel("wiki_search")).toBe("wiki_search");
  });
});

describe("emptyAgentSegment", () => {
  it("is the idle projection", () => {
    expect(emptyAgentSegment()).toEqual({
      text: "",
      items: [],
      tools: [],
      pending: [],
      suspendedBatchId: null,
      reasoningText: "",
      reasoningMs: null,
      citations: [],
      hasIngress: false,
    });
  });
});

describe("segmentFromAssistantMessage — text", () => {
  it("returns the empty segment for undefined or non-assistant messages", () => {
    expect(segmentFromAssistantMessage(undefined)).toEqual(emptyAgentSegment());
    expect(segmentFromAssistantMessage(user("hi"))).toEqual(emptyAgentSegment());
  });

  it("merges consecutive text parts into one timeline item and sets hasIngress", () => {
    const segment = segmentFromAssistantMessage(assistant([text("Hello "), text("world")]));
    expect(segment.text).toBe("Hello world");
    expect(segment.hasIngress).toBe(true);
    expect(segment.items).toHaveLength(1);
    expect(segment.items[0]).toMatchObject({ kind: "text", text: "Hello world" });
  });
});

describe("segmentFromAssistantMessage — reasoning", () => {
  it("accumulates a reasoning burst into one item and leaves ms null (no fabricated duration)", () => {
    const segment = segmentFromAssistantMessage(assistant([reasoning("think "), reasoning("harder")]));
    expect(segment.reasoningText).toBe("think harder");
    expect(segment.reasoningMs).toBeNull();
    expect(segment.hasIngress).toBe(true);
    expect(segment.items).toEqual([{ id: expect.any(Number), kind: "reasoning", text: "think harder", ms: null }]);
  });

  it("reads a real reasoning duration from the message metadata", () => {
    const segment = segmentFromAssistantMessage(assistant([reasoning("think")], { reasoningMs: 4200 }));
    expect(segment.reasoningMs).toBe(4200);
  });

  it("ignores a non-numeric reasoning duration in metadata", () => {
    expect(segmentFromAssistantMessage(assistant([reasoning("think")], { reasoningMs: "4200" })).reasoningMs).toBeNull();
  });

  it("keeps reasoningMs null when no reasoning arrived", () => {
    expect(segmentFromAssistantMessage(assistant([text("hi")])).reasoningMs).toBeNull();
  });
});

describe("segmentFromAssistantMessage — timeline order", () => {
  it("interleaves text, tool and reasoning in arrival order", () => {
    const segment = segmentFromAssistantMessage(
      assistant([text("a"), toolCall("web_search", "call_1", { detail: 'Searching wiki for "x"' }), reasoning("hmm"), text("b")])
    );
    expect(segment.items.map((i) => i.kind)).toEqual(["text", "tool", "reasoning", "text"]);
    expect(segment.text).toBe("ab");
    expect(segment.reasoningText).toBe("hmm");
  });
});

describe("segmentFromAssistantMessage — tool parts", () => {
  it("projects an input-available call to a call-phase chip with the input detail", () => {
    const segment = segmentFromAssistantMessage(
      assistant([toolCall("web_search", "call_1", { detail: 'Searching wiki for "setup"' })])
    );
    expect(segment.tools).toEqual([
      { key: "call_1", name: "web_search", label: "Searching web…", phase: "call", detail: 'Searching wiki for "setup"' },
    ]);
    expect(segment.items[0]).toMatchObject({ kind: "tool" });
    expect(segment.hasIngress).toBe(true);
  });

  it("flips the same chip to result when the output arrives and carries the result detail", () => {
    const segment = segmentFromAssistantMessage(
      assistant([toolResult("web_search", "call_1", { detail: "searching" }, { detail: "3 results" })])
    );
    expect(segment.tools).toHaveLength(1);
    expect(segment.tools[0]).toMatchObject({
      key: "call_1",
      name: "web_search",
      phase: "result",
      detail: "searching",
      resultDetail: "3 results",
    });
    expect(segment.items).toHaveLength(1);
  });

  it("keeps the call detail when a result arrives from a separate part", () => {
    const segment = segmentFromAssistantMessage(
      assistant([toolCall("web_search", "call_1", { detail: "searching" }), toolResult("web_search", "call_1", undefined, "done")])
    );
    expect(segment.tools).toHaveLength(1);
    expect(segment.tools[0]).toMatchObject({ phase: "result", detail: "searching", resultDetail: "done" });
  });

  it("reads the human sentence from the input's arg fallback", () => {
    const segment = segmentFromAssistantMessage(assistant([toolCall("fetch_url", "c1", { arg: "https://x.test" })]));
    expect(segment.tools[0]!.detail).toBe("https://x.test");
  });

  it("projects output-error to a result chip with the errorText as result detail", () => {
    const segment = segmentFromAssistantMessage(assistant([toolError("read_s3_file", "c1", {}, "boom")]));
    expect(segment.tools[0]).toMatchObject({ name: "read_s3_file", phase: "result", resultDetail: "boom" });
  });

  it("uses the toolName for a dynamic-tool part", () => {
    const segment = segmentFromAssistantMessage(assistant([dynamicTool("custom_tool", "c9", "input-available")]));
    expect(segment.tools[0]).toMatchObject({ name: "custom_tool", key: "c9", phase: "call", label: "custom_tool" });
  });

  it("reads a string output as the result detail", () => {
    const segment = segmentFromAssistantMessage(assistant([toolResult("fetch_url", "c1", {}, "content here")]));
    expect(segment.tools[0]!.resultDetail).toBe("content here");
  });
});

describe("segmentFromAssistantMessage — citations", () => {
  it("collects https source-url parts with hostname and title", () => {
    const segment = segmentFromAssistantMessage(
      assistant([sourceUrl("https://example.com/a", "Example"), sourceUrl("https://docs.test/b")])
    );
    expect(segment.citations).toEqual([
      { url: "https://example.com/a", title: "Example", hostname: "example.com" },
      { url: "https://docs.test/b", title: null, hostname: "docs.test" },
    ]);
  });

  it("drops non-https and unparseable urls", () => {
    const segment = segmentFromAssistantMessage(assistant([sourceUrl("http://insecure.test"), sourceUrl("not a url")]));
    expect(segment.citations).toEqual([]);
  });

  it("dedupes citations by url", () => {
    const segment = segmentFromAssistantMessage(
      assistant([sourceUrl("https://example.com/a", "Example"), sourceUrl("https://example.com/a", "Example again")])
    );
    expect(segment.citations).toEqual([{ url: "https://example.com/a", title: "Example", hostname: "example.com" }]);
  });
});

describe("segmentFromAssistantMessage — approval chips", () => {
  it("builds a pending chip from a full tool output payload", () => {
    const segment = segmentFromAssistantMessage(
      assistant([
        toolResult("create_task", "c1", {}, {
          approvalId: "a1",
          batchId: "b1",
          seq: 0,
          name: "create_task",
          detail: "Create task",
          diff: DIFF,
        }),
      ])
    );
    expect(segment.pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", detail: "Create task", diff: DIFF },
    ]);
    expect(segment.suspendedBatchId).toBe("b1");
  });

  it("ignores a proposal-only tool output with no batchId/diff (P3 engine shape)", () => {
    const segment = segmentFromAssistantMessage(
      assistant([toolResult("create_task", "c1", {}, { proposed: true, approvalId: "a1" })])
    );
    expect(segment.pending).toEqual([]);
    expect(segment.suspendedBatchId).toBeNull();
  });

  it("builds chips from a single data-part payload", () => {
    const segment = segmentFromAssistantMessage(
      assistant([dataPart("assistant-approval", { approvalId: "a2", batchId: "b2", seq: 1, name: "delete_task", diff: DIFF })])
    );
    expect(segment.pending).toEqual([{ approvalId: "a2", batchId: "b2", seq: 1, name: "delete_task", diff: DIFF }]);
  });

  it("builds chips from a batch envelope and sorts by seq", () => {
    const segment = segmentFromAssistantMessage(
      assistant([
        dataPart("assistant-approval", {
          batchId: "b3",
          approvals: [
            { approvalId: "a2", seq: 1, name: "delete_task", diff: DIFF },
            { approvalId: "a1", seq: 0, name: "create_task", diff: DIFF },
          ],
        }),
      ])
    );
    expect(segment.pending.map((c) => c.approvalId)).toEqual(["a1", "a2"]);
    expect(segment.suspendedBatchId).toBe("b3");
  });

  it("ignores data parts that are not approval envelopes", () => {
    const segment = segmentFromAssistantMessage(assistant([dataPart("usage", { tokens: 1 })]));
    expect(segment.pending).toEqual([]);
    expect(segment.suspendedBatchId).toBeNull();
  });
});

describe("segmentFromMessages — merged suspension projection (LX-120)", () => {
  it("projects a carrier landing on an earlier assistant message than the last", () => {
    const carrier = assistant([
      toolResult("create_task", "c1", {}, {
        approvalId: "a1",
        batchId: "b1",
        seq: 0,
        name: "create_task",
        detail: "Create task",
        diff: DIFF,
      }),
    ]);
    const messages = [user("go"), carrier, assistant([text("done")])];
    const segment = segmentFromMessages(messages);
    expect(segment.suspendedBatchId).toBe("b1");
    expect(segment.pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", detail: "Create task", diff: DIFF },
    ]);
    // `segmentFromMessages` still projects the last message's own text.
    expect(segment.text).toBe("done");
  });

  it("flips suspendedBatchId for a marker-only carrier (no reconstructable chips)", () => {
    const messages = [
      user("go"),
      assistant([text("proposed"), dataPart("assistant-approval", { batchId: "b9", approvals: [] })]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBe("b9");
    expect(pending).toEqual([]);
    expect(segmentFromMessages(messages).suspendedBatchId).toBe("b9");
  });

  it("merges chips for the same batch split across trailing messages", () => {
    const messages = [
      user("go"),
      assistant([dataPart("assistant-approval", { batchId: "b1", approvals: [{ approvalId: "a2", seq: 1, name: "delete_task", diff: DIFF }] })]),
      assistant([dataPart("assistant-approval", { batchId: "b1", approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }] })]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(pending.map((c) => c.approvalId)).toEqual(["a1", "a2"]);
    expect(suspendedBatchId).toBe("b1");
  });

  it("does not re-arm a batch whose chips are all terminal", () => {
    const messages = [
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "approved", diff: DIFF },
    ]);
  });

  it("ignores a suspension from an earlier trailing turn", () => {
    const messages = [
      user("first"),
      assistant([dataPart("assistant-approval", { batchId: "b1", approvals: [] })]),
      user("second"),
      assistant([text("ok")]),
    ];
    expect(suspensionFromMessages(messages).suspendedBatchId).toBeNull();
    expect(segmentFromMessages(messages).suspendedBatchId).toBeNull();
  });

  // Two carriers for one approval (the merged shape the DO persists): a pending
  // carrier must never overwrite an already-terminal chip, in EITHER arrival
  // order, or the batch re-arms and the UI POSTs `/resume` for an executed batch.
  it("keeps the terminal chip when a pending carrier arrives after it (terminal→pending)", () => {
    const messages = [
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }],
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "approved", diff: DIFF },
    ]);
  });

  it("adopts the terminal chip when it arrives after a pending carrier (pending→terminal)", () => {
    const messages = [
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }],
        }),
      ]),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "approved", diff: DIFF },
    ]);
  });

  // The decision can ride the live proposal output itself; the adapter must read
  // `output.status` (the server's `approvalFromProposal` does) or a terminal
  // carrier projects as pending and re-arms an executed batch.
  it("adopts a terminal tool-output carrier arriving after a pending one (pending→terminal)", () => {
    const messages = [
      user("go"),
      assistant([
        toolResult("create_task", "c1", {}, {
          approvalId: "a1",
          batchId: "b1",
          seq: 0,
          name: "create_task",
          detail: "Create task",
          diff: DIFF,
        }),
      ]),
      assistant([
        toolResult("create_task", "c2", {}, {
          approvalId: "a1",
          batchId: "b1",
          seq: 0,
          name: "create_task",
          detail: "Create task",
          diff: DIFF,
          status: "approved",
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", detail: "Create task", state: "approved", diff: DIFF },
    ]);
  });

  it("keeps a terminal tool-output carrier when a pending carrier arrives after it (terminal→pending)", () => {
    const messages = [
      user("go"),
      assistant([
        toolResult("create_task", "c1", {}, {
          approvalId: "a1",
          batchId: "b1",
          seq: 0,
          name: "create_task",
          detail: "Create task",
          diff: DIFF,
          status: "approved",
        }),
      ]),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }],
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", detail: "Create task", state: "approved", diff: DIFF },
    ]);
  });

  // Terminal-vs-terminal: the later carrier is the newer decision.
  it("lets the later terminal carrier win between two terminal carriers", () => {
    const messages = [
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "rejected" }],
        }),
      ]),
    ];
    const { pending, suspendedBatchId } = suspensionFromMessages(messages);
    expect(suspendedBatchId).toBeNull();
    expect(pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "rejected", diff: DIFF },
    ]);
  });
});

describe("lastAssistantMessage / hasUserMessage", () => {
  it("returns the last assistant message and detects user ingress", () => {
    const a1 = assistant([text("first")]);
    const a2 = assistant([text("second")]);
    expect(lastAssistantMessage([user("hi"), a1, a2])).toBe(a2);
    expect(lastAssistantMessage([user("hi")])).toBeUndefined();
    expect(hasUserMessage([user("hi")])).toBe(true);
    expect(hasUserMessage([a1])).toBe(false);
  });
});

describe("message metadata helpers", () => {
  it("reads reasoningMs only from a real numeric metadata duration", () => {
    expect(reasoningMsFromMessage(assistant([reasoning("x")], { reasoningMs: 1500 }))).toBe(1500);
    expect(reasoningMsFromMessage(assistant([reasoning("x")], { reasoningMs: null }))).toBeNull();
    expect(reasoningMsFromMessage(assistant([reasoning("x")], {}))).toBeNull();
    expect(reasoningMsFromMessage(assistant([reasoning("x")]))).toBeNull();
    expect(reasoningMsFromMessage(undefined)).toBeNull();
  });

  it("maps metadata.usage to the { in, out } snapshot shape", () => {
    expect(usageFromMessage(assistant([text("x")], { usage: { in: 10, out: 4 } }))).toEqual({ in: 10, out: 4 });
    expect(usageFromMessage(assistant([text("x")], { usage: { input: 10, output: 4 } }))).toEqual({ in: 10, out: 4 });
    expect(usageFromMessage(assistant([text("x")], { usage: { inputTokens: 10, outputTokens: 4 } }))).toEqual({ in: 10, out: 4 });
    expect(usageFromMessage(assistant([text("x")], { usage: { in: 10 } }))).toEqual({ in: 10, out: 0 });
  });

  it("returns null usage when metadata carries none", () => {
    expect(usageFromMessage(assistant([text("x")]))).toBeNull();
    expect(usageFromMessage(assistant([text("x")], { usage: { tokens: 1 } }))).toBeNull();
    expect(usageFromMessage(undefined)).toBeNull();
  });
});

describe("statusFromChat", () => {
  const seg = (overrides: Partial<ReturnType<typeof emptyAgentSegment>> = {}) => ({ ...emptyAgentSegment(), ...overrides });

  it("maps the SDK chat status onto the stream status union", () => {
    expect(statusFromChat("error", seg(), undefined)).toBe("error");
    expect(statusFromChat("ready", seg(), new Error("x"))).toBe("error");
    expect(statusFromChat("submitted", seg(), undefined)).toBe("connecting");
    expect(statusFromChat("streaming", seg(), undefined)).toBe("connecting");
    expect(statusFromChat("streaming", seg({ hasIngress: true }), undefined)).toBe("streaming");
    expect(statusFromChat("ready", seg({ hasIngress: true }), undefined)).toBe("done");
    expect(statusFromChat("ready", seg(), undefined)).toBe("idle");
  });

  it("reports suspended whenever a batch is awaiting decisions", () => {
    expect(statusFromChat("ready", seg({ suspendedBatchId: "b1" }), undefined)).toBe("suspended");
  });
});

describe("snapshotFromSegment", () => {
  it("folds the segment into the legacy snapshot with empty frames", () => {
    const segment = segmentFromAssistantMessage(assistant([text("hi")]));
    const snapshot = snapshotFromSegment(segment, { status: "ready", error: undefined, usage: { in: 1, out: 2 } });
    expect(snapshot).toMatchObject({
      status: "done",
      frames: [],
      text: "hi",
      pending: [],
      suspendedBatchId: null,
      error: null,
      usage: { in: 1, out: 2 },
      hasIngress: true,
      reasoningActive: false,
    });
  });

  it("maps an SDK error to the assistant error frame shape", () => {
    const snapshot = snapshotFromSegment(emptyAgentSegment(), {
      status: "error",
      error: Object.assign(new Error("nope"), { code: "PROVIDER_UNREACHABLE" }),
    });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toEqual({ code: "PROVIDER_UNREACHABLE", message: "nope" });
  });

  it("defaults the error code when the SDK error carries none", () => {
    const snapshot = snapshotFromSegment(emptyAgentSegment(), { status: "error", error: new Error("nope") });
    expect(snapshot.error).toEqual({ code: "ASSISTANT_GENERATION_FAILED", message: "nope" });
  });

  it("reports usage null when omitted", () => {
    expect(snapshotFromSegment(emptyAgentSegment(), { status: "ready", error: undefined }).usage).toBeNull();
  });

  it("surfaces a terminal connection error as the failed state", () => {
    const connError = Object.assign(new Error("socket closed"), { code: 1006, reason: "abnormal", wasClean: false });
    const snapshot = snapshotFromSegment(emptyAgentSegment(), { status: "ready", error: undefined, connectionError: connError });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toEqual({ code: "ASSISTANT_CONNECTION_LOST", message: "socket closed" });
  });

  it("prefers an explicit chat error over the transport error", () => {
    const connError = Object.assign(new Error("socket closed"), { code: 1006 });
    const chatError = Object.assign(new Error("bad request"), { code: "PROVIDER_UNREACHABLE" });
    const snapshot = snapshotFromSegment(emptyAgentSegment(), { status: "error", error: chatError, connectionError: connError });
    expect(snapshot.error).toEqual({ code: "PROVIDER_UNREACHABLE", message: "bad request" });
  });
});

describe("agentSendParts", () => {
  it("emits a text part plus one data-attachment part per attachment", () => {
    expect(
      agentSendParts({
        message: "hello",
        attachments: [{ storageKey: "k1", mimeType: "image/png", name: "a.png" }],
      })
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "data-attachment", data: { storageKey: "k1", mimeType: "image/png", name: "a.png" } },
    ]);
  });

  it("omits an empty message but keeps attachments", () => {
    expect(agentSendParts({ message: "", attachments: [{ storageKey: "k1", mimeType: "image/png", name: "a.png" }] })).toHaveLength(1);
  });

  it("returns no parts for an empty body", () => {
    expect(agentSendParts({})).toEqual([]);
  });
});

describe("agentSendMetadata", () => {
  it("forwards only the request-level fields that are present", () => {
    expect(
      agentSendMetadata({
        projectId: "p1",
        chatId: "c1",
        fromIndex: 3,
        reasoningEffort: "high",
        attachments: [{ storageKey: "k1", mimeType: "image/png", name: "a.png" }],
      })
    ).toEqual({
      projectId: "p1",
      chatId: "c1",
      fromIndex: 3,
      reasoningEffort: "high",
      attachments: [{ storageKey: "k1", mimeType: "image/png", name: "a.png" }],
    });
  });

  it("omits absent fields, including fromIndex 0 (a real fork index)", () => {
    expect(agentSendMetadata({ chatId: "c1", fromIndex: 0 })).toEqual({ chatId: "c1", fromIndex: 0 });
    expect(agentSendMetadata({})).toEqual({});
  });
});
