import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderTranscript } from "./assistant-chat-utils";
import type { ChatTurn } from "./assistant-chat-utils";
import { chipStateFromError, dropUnknownThread, resolveChatId, resolveResendTarget, resumableBatchId } from "./assistant-chat-logic";

const user = (text: string, rawIndex = -1): ChatTurn => ({ role: "user", text, imageCount: 0, rawIndex });
const assistant = (text: string, rawIndex = -1, error?: { code: string; message: string }): ChatTurn => ({
  role: "assistant",
  text,
  imageCount: 0,
  rawIndex,
  ...(error ? { error } : {}),
});

const DIFF = { type: "task_delete", taskRef: "LX-1", taskTitle: "old" } as const;

describe("renderTranscript — persisted pendingBatch approvals", () => {
  it("rebuilds decidable chips from the full approvals payload", () => {
    const turns = renderTranscript([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [{ approvalId: "a1", toolCallId: "call_1", seq: 0, name: "delete_task", detail: "Delete LX-1", diff: DIFF }],
        },
      },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.batch).toEqual({
      batchId: "b1",
      chips: [{ approvalId: "a1", batchId: "b1", seq: 0, name: "delete_task", detail: "Delete LX-1", diff: DIFF, state: "pending" }],
    });
    expect(turns[0]!.suspendedBatchId).toBeUndefined();
  });

  it("falls back to the waiting marker when the payload is incomplete", () => {
    const turns = renderTranscript([
      { role: "assistant", content: "proposed", pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] } },
    ]);
    expect(turns[0]!.batch).toBeUndefined();
    expect(turns[0]!.suspendedBatchId).toBe("b1");
  });

  it("keeps legacy string markers marker-only", () => {
    const turns = renderTranscript([{ role: "assistant", content: "proposed", pendingBatch: "b-legacy" }]);
    expect(turns[0]!.suspendedBatchId).toBe("b-legacy");
  });

  it("renders a reconciled decision as a terminal chip, not pending", () => {
    const turns = renderTranscript([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [
            { approvalId: "a1", toolCallId: "call_1", seq: 0, name: "delete_task", diff: DIFF, status: "approved" },
            { approvalId: "a2", toolCallId: "call_2", seq: 1, name: "create_task", diff: { type: "task_create", title: "t", fields: {} }, status: "rejected" },
          ],
        },
      },
    ]);
    expect(turns[0]!.batch?.chips.map((c) => c.state)).toEqual(["approved", "rejected"]);
  });
});

describe("renderTranscript — LX-124 continuation boundary", () => {
  it("renders the proposal and continuation as two assistant turns, marker invisible", () => {
    const turns = renderTranscript([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "proposed" },
          { type: "data-assistant-approval", data: { batchId: "b1", approvals: [{ approvalId: "a1", seq: 0, name: "delete_task", diff: DIFF }] } },
        ],
      },
      { id: "a1~boundary~b1", role: "assistant", parts: [{ type: "data-continuation", data: { batchId: "b1", ts: "2026-01-01T00:00:00Z" } }] },
      { id: "a1~cont~b1", role: "assistant", parts: [{ type: "text", text: "Done — nothing ran." }] },
    ]);

    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    // The empty marker turn is skipped: raw indices are the two real turns.
    expect(turns.map((t) => t.rawIndex)).toEqual([0, 1, 3]);
    // Proposal bubble keeps its chips; the continuation bubble has text only.
    expect(turns[1]!.batch?.batchId).toBe("b1");
    expect(turns[2]!.text).toBe("Done — nothing ran.");
    expect(turns[2]!.batch).toBeUndefined();
    expect(turns[2]!.suspendedBatchId).toBeUndefined();
  });
});

describe("resolveChatId", () => {
  const base = {
    projectId: "p1",
    thread: undefined as string | undefined,
    currentChatId: "",
  };

  it("prefers ?thread= over the active selection", () => {
    expect(resolveChatId({ ...base, thread: "t1", currentChatId: "t2" })).toBe("t1");
  });

  it("treats a ?thread= equal to the active selection as already applied", () => {
    expect(resolveChatId({ ...base, thread: "t1", currentChatId: "t1" })).toBeNull();
  });

  it("opens the fresh landing when there is no ?thread= and no active selection", () => {
    expect(resolveChatId(base)).toBeNull();
  });

  it("does not clobber an active selection", () => {
    expect(resolveChatId({ ...base, currentChatId: "active" })).toBeNull();
  });

  it("returns null without a resolved project", () => {
    expect(resolveChatId({ ...base, projectId: undefined, thread: "t1" })).toBeNull();
  });

  it("restores the last active thread when there is no deep link", () => {
    expect(resolveChatId({ ...base, lastVisited: "A" })).toBe("A");
  });

  it("does not re-apply the last active thread once it is the current selection", () => {
    expect(resolveChatId({ ...base, currentChatId: "A", lastVisited: "A" })).toBeNull();
  });

  it("an explicit deep link wins over the last active thread", () => {
    expect(resolveChatId({ ...base, thread: "t1", lastVisited: "A" })).toBe("t1");
  });

  it("lands fresh when the last-visited memory is empty", () => {
    expect(resolveChatId({ ...base, lastVisited: null })).toBeNull();
    expect(resolveChatId(base)).toBeNull();
  });
});

describe("resolveResendTarget — one raw index space", () => {
  it("maps an optimistic retry trigger to its raw user message", () => {
    // The display turn is optimistic (rawIndex -1) but the prompt persisted.
    const turns = [user("hello"), assistant("", -1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    const raw = [{ role: "user", content: "hello" }];
    const resolved = resolveResendTarget({ turns, target: turns[1]!, rawMessages: raw, mode: "retry" });
    expect(resolved).toEqual({ turn: turns[0], index: 0 });
  });

  it("resolves a retry against the raw transcript turn position", () => {
    const raw = [{ role: "user", content: "hello" }, { role: "assistant", content: "x" }];
    const turns = [user("hello", 0), assistant("x", 1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    expect(resolveResendTarget({ turns, target: turns[1]!, rawMessages: raw, mode: "retry" })).toEqual({
      turn: turns[0],
      index: 0,
    });
  });

  it("ignores a stale raw position and finds the user message by text (no early truncation)", () => {
    // Display is stale: "next" claims raw index 0, which now holds "hello".
    // Falling back to the position would truncate to [hello] and drop "next".
    const raw = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "x" },
      { role: "user", content: "next" },
      { role: "assistant", content: "y" },
    ];
    const target = user("next", 0);
    expect(resolveResendTarget({ turns: [target], target, rawMessages: raw, mode: "regenerate" })).toEqual({
      turn: target,
      index: 2,
    });
  });

  it("returns null for an unmappable trigger (never a sentinel index)", () => {
    const turns = [user("ghost"), assistant("", -1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    expect(resolveResendTarget({ turns, target: turns[1]!, rawMessages: [], mode: "retry" })).toBeNull();
  });

  it("returns null when a retry has no preceding user turn", () => {
    const turns = [assistant("", -1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    expect(resolveResendTarget({ turns, target: turns[0]!, rawMessages: [], mode: "retry" })).toBeNull();
  });

  it("floors the duplicate-text fallback: stale raw + optimistic retry cannot target the older identical prompt", () => {
    // Two identical prompts: the FIRST exchange is persisted, the second is
    // still optimistic and the second prompt has not landed in `raw` yet. The
    // bare text fallback would pick raw index 0 (the older "hello") and the
    // server would truncate the thread to it, dropping "a1" and everything
    // after. The floor (just past the last known raw turn) makes it null.
    const turns = [user("hello", 0), assistant("a1", 1), user("hello"), assistant("", -1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    const staleRaw = [{ role: "user", content: "hello" }, { role: "assistant", content: "a1" }];
    expect(resolveResendTarget({ turns, target: turns[3]!, rawMessages: staleRaw, mode: "retry" })).toBeNull();
  });

  it("resolves the LAST duplicate once the raw transcript catches up", () => {
    const turns = [user("hello", 0), assistant("a1", 1), user("hello"), assistant("", -1, { code: "PROVIDER_UNREACHABLE", message: "x" })];
    const raw = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "a2" },
    ];
    expect(resolveResendTarget({ turns, target: turns[3]!, rawMessages: raw, mode: "retry" })).toEqual({ turn: turns[2], index: 2 });
  });
});

describe("dropUnknownThread — fresh landing, never a list head", () => {
  const thread = (chatId: string) => ({ chatId, title: chatId, pinned: false, snippet: null, createdAt: "x", updatedAt: "x" });

  it("clears the selection, evicts the dead id and never applies the next live head", () => {
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chat", "dead"], { messages: [] });
    qc.setQueryData(["assistant-chats", "p1", null], [thread("dead"), thread("live")]);
    qc.setQueryData(["assistant-chats", "p1", "q"], [thread("dead"), thread("other")]);
    const applied: string[] = [];
    let cleared = false;
    dropUnknownThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {
        cleared = true;
      },
      clearParam: true,
    });
    // The live head "live" must NOT be applied — only the fresh empty state.
    expect(applied).toEqual(["set:"]);
    expect(cleared).toBe(true);
    expect(qc.getQueryState(["assistant-chat", "dead"])).toBeUndefined();
    expect(qc.getQueryData(["assistant-chats", "p1", null])).toEqual([thread("live")]);
    expect(qc.getQueryData(["assistant-chats", "p1", "q"])).toEqual([thread("other")]);
  });

  it("keeps the param when the URL no longer carries the dead thread", () => {
    const qc = new QueryClient();
    let cleared = false;
    const applied: string[] = [];
    dropUnknownThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {
        cleared = true;
      },
      clearParam: false,
    });
    expect(applied).toEqual(["set:"]);
    expect(cleared).toBe(false);
  });
});

describe("chipStateFromError", () => {
  it("retires a chip whose decision row is gone, so the composer cannot stay locked", () => {
    expect(chipStateFromError(Object.assign(new Error("missing"), { code: "APPROVAL_NOT_FOUND" }))).toBe("expired");
  });

  it("keeps the existing decision-state mappings", () => {
    expect(chipStateFromError(Object.assign(new Error("x"), { code: "APPROVAL_EXPIRED" }))).toBe("expired");
    expect(
      chipStateFromError(Object.assign(new Error("x"), { code: "APPROVAL_ALREADY_DECIDED", details: { status: "approved" } }))
    ).toBe("approved");
    expect(chipStateFromError(Object.assign(new Error("x"), { code: "OTHER" }))).toBeNull();
  });
});

describe("resumableBatchId — resume guards (LX-81/82/83)", () => {
  type ChipState = "pending" | "approved" | "rejected" | "expired";
  const batchTurn = (batchId: string, ...states: ChipState[]): ChatTurn =>
    ({
      role: "assistant",
      text: "",
      imageCount: 0,
      rawIndex: -1,
      batch: {
        batchId,
        chips: states.map((state, seq) => ({ approvalId: `${batchId}-${seq}`, batchId, seq, name: "t", diff: {}, state })),
      },
    }) as ChatTurn;
  const userTurn = (): ChatTurn =>
    ({ role: "user", text: "go", imageCount: 0, rawIndex: -1 }) as ChatTurn;

  it("skips a batch already in the resumed set (persisted across reload)", () => {
    const turns = [batchTurn("b1", "approved")];
    expect(resumableBatchId(turns, new Set())).toBe("b1");
    expect(resumableBatchId(turns, new Set(["b1"]))).toBeNull();
  });

  it("never resumes a batch that still has a pending chip", () => {
    expect(resumableBatchId([batchTurn("b1", "pending")], new Set())).toBeNull();
    // Mixed pending + approved: still awaiting a decision, so not resumable.
    expect(resumableBatchId([batchTurn("b1", "approved", "pending")], new Set())).toBeNull();
  });

  it("requires at least one approved chip — a fully rejected/expired batch has nothing to execute", () => {
    expect(resumableBatchId([batchTurn("b1", "rejected")], new Set())).toBeNull();
    expect(resumableBatchId([batchTurn("b1", "expired", "rejected")], new Set())).toBeNull();
  });

  it("only considers the trailing region after the last user turn", () => {
    // The batch precedes the newest user turn: settled history, never resumed.
    expect(resumableBatchId([batchTurn("b1", "approved"), userTurn()], new Set())).toBeNull();
    // The batch follows the newest user turn: eligible.
    expect(resumableBatchId([userTurn(), batchTurn("b1", "approved")], new Set())).toBe("b1");
  });

  it("scans past a pending newer batch to an older fully-terminal one (LX-82)", () => {
    expect(resumableBatchId([batchTurn("b1", "approved"), batchTurn("b2", "pending")], new Set())).toBe("b1");
  });

  it("picks the newest fully-terminal not-yet-resumed batch", () => {
    const turns = [batchTurn("b1", "approved"), batchTurn("b2", "approved")];
    expect(resumableBatchId(turns, new Set())).toBe("b2");
    expect(resumableBatchId(turns, new Set(["b2"]))).toBe("b1");
  });

  it("resumes an all-rejected/expired batch decided in this session (acknowledgment)", () => {
    expect(resumableBatchId([batchTurn("b1", "rejected")], new Set(), new Set(["b1"]))).toBe("b1");
    expect(resumableBatchId([batchTurn("b1", "expired")], new Set(), new Set(["b1"]))).toBe("b1");
    expect(resumableBatchId([batchTurn("b1", "expired", "rejected")], new Set(), new Set(["b1"]))).toBe("b1");
  });

  it("never resumes a transcript-loaded terminal batch never observed pending in-session", () => {
    expect(resumableBatchId([batchTurn("b1", "rejected")], new Set())).toBeNull();
    expect(resumableBatchId([batchTurn("b1", "rejected")], new Set(), new Set(["other"]))).toBeNull();
  });

  it("does not resume an in-session batch that still holds a pending chip", () => {
    expect(resumableBatchId([batchTurn("b1", "approved", "pending")], new Set(), new Set(["b1"]))).toBeNull();
  });

  it("requires chips for the in-session path (a marker-only batch never resumes)", () => {
    const marker: ChatTurn = { role: "assistant", text: "", imageCount: 0, rawIndex: -1, suspendedBatchId: "b1" };
    expect(resumableBatchId([marker], new Set(), new Set(["b1"]))).toBeNull();
  });
});
