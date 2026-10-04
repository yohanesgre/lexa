import { describe, expect, it } from "vitest";
import { carryKnownDecisions, settleTurns, settleTurnsWithRaw } from "./assistant-chat-turns-state";
import type { ChatTurn } from "./assistant-chat-utils";
import type { ApprovalChip } from "./AssistantApprovals";

const DIFF: ApprovalChip["diff"] = { type: "task_create", title: "New task", fields: {} };

function chip(over: Partial<ApprovalChip> & { approvalId: string }): ApprovalChip {
  return {
    batchId: "b1",
    seq: 0,
    name: "create_task",
    diff: DIFF,
    state: "pending",
    ...over,
  };
}

describe("carryKnownDecisions", () => {
  it("preserves terminal decisions from prev by approvalId", () => {
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: {
          batchId: "b1",
          chips: [chip({ approvalId: "a1", state: "approved" }), chip({ approvalId: "a2", state: "rejected" })],
        },
      },
    ];
    const rebuilt: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1" }), chip({ approvalId: "a2" })] },
      },
    ];
    const out = carryKnownDecisions(prev, rebuilt);
    expect(out[0]!.batch!.chips[0]!.state).toBe("approved");
    expect(out[0]!.batch!.chips[1]!.state).toBe("rejected");
    // input untouched
    expect(rebuilt[0]!.batch!.chips[0]!.state).toBe("pending");
  });

  it("leaves unknown approvals pending and new batches unaffected", () => {
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "old",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1", state: "approved" })] },
      },
    ];
    const rebuilt: ChatTurn[] = [
      {
        role: "assistant",
        text: "old",
        imageCount: 0,
        rawIndex: 1,
        batch: {
          batchId: "b1",
          chips: [chip({ approvalId: "a1" }), chip({ approvalId: "unknown" })],
        },
      },
      {
        role: "assistant",
        text: "new",
        imageCount: 0,
        rawIndex: 2,
        batch: { batchId: "b2", chips: [chip({ approvalId: "a3", batchId: "b2" })] },
      },
    ];
    const out = carryKnownDecisions(prev, rebuilt);
    expect(out[0]!.batch!.chips[0]!.state).toBe("approved");
    expect(out[0]!.batch!.chips[1]!.state).toBe("pending");
    expect(out[1]!.batch!.chips[0]!.state).toBe("pending");
  });

  it("returns the rebuilt list identity when prev carries no terminal decision", () => {
    const rebuilt: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1" })] },
      },
    ];
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1", state: "pending" })] },
      },
    ];
    expect(carryKnownDecisions(prev, rebuilt)).toBe(rebuilt);
    expect(carryKnownDecisions(null, rebuilt)).toBe(rebuilt);
  });
});

describe("settleTurns — decided batch survives a transcript rebuild", () => {
  it("keeps an all-terminal batch terminal instead of re-arming it", () => {
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1", state: "approved" })] },
      },
    ];
    // A persisted marker with no reconciled status rebuilds to pending; the
    // settle pass must carry the session's decision back over it.
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }] },
      },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "idle", hasIngress: false });
    expect(out).not.toBeNull();
    const chips = out!.find((t) => t.batch)!.batch!.chips;
    expect(chips[0]!.state).toBe("approved");
    expect(chips.some((c) => c.state === "pending")).toBe(false);
  });

  it("applies reconciled server decisions over cached pending chips (remount reconciliation)", () => {
    // Cache held the pre-decision marker → chips pending in the optimistic view.
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: {
          batchId: "b1",
          chips: [chip({ approvalId: "a1" }), chip({ approvalId: "a2", seq: 1 })],
        },
      },
    ];
    // The refetched transcript reconciled the decisions (same message count —
    // only the marker status fields changed).
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [
            { approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" },
            { approvalId: "a2", seq: 1, name: "create_task", diff: DIFF, status: "rejected" },
          ],
        },
      },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "idle", hasIngress: false });
    expect(out).not.toBeNull();
    const chips = out!.find((t) => t.batch)!.batch!.chips;
    expect(chips.find((c) => c.approvalId === "a1")!.state).toBe("approved");
    expect(chips.find((c) => c.approvalId === "a2")!.state).toBe("rejected");
    expect(chips.some((c) => c.state === "pending")).toBe(false);
  });

  it("keeps the optimistic view when the server transcript still shows the batch pending", () => {
    const prev: ChatTurn[] = [
      {
        role: "assistant",
        text: "proposed",
        imageCount: 0,
        rawIndex: 1,
        batch: { batchId: "b1", chips: [chip({ approvalId: "a1" })] },
      },
    ];
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }] },
      },
    ];
    expect(settleTurns({ prev, messages, streaming: false, streamStatus: "idle", hasIngress: false })).toBe(prev);
  });
});

// A8: at a terminal frame the server transcript read can be transiently
// run-scoped (a DO read that holds only the current turn). Replacing the
// settled local view with it erases earlier turns; settleTurns must reconcile
// instead — keep prev's earlier turns and merge the server's own tail.
describe("settleTurns — terminal shorter transcript reconciliation (A8)", () => {
  function turn(role: "user" | "assistant", text: string, rawIndex: number): ChatTurn {
    return { role, text, imageCount: 0, rawIndex };
  }

  it("keeps earlier turns and merges the server's new tail at done", () => {
    const prev: ChatTurn[] = [
      turn("user", "one", 0),
      turn("assistant", "reply one", 1),
      turn("user", "two", 2),
      turn("assistant", "reply two", 3),
      // The in-flight run's optimistic user turn.
      turn("user", "three", -1),
    ];
    // The captured terminal GET: only the current run's messages.
    const messages = [
      { role: "user", content: "three" },
      { role: "assistant", content: "reply three" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "reply two", "three", "reply three"]);
  });

  it("appends an assistant-only server tail without dropping history", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("user", "two", -1)];
    const out = settleTurns({
      prev,
      messages: [{ role: "assistant", content: "tail reply" }],
      streaming: false,
      streamStatus: "done",
      hasIngress: true,
    });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "tail reply"]);
  });

  it("does not reconcile a full server read (only a shorter one regresses)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("user", "two", -1)];
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "reply two" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "reply two"]);
  });

  it("follows reset semantics for a genuinely cleared transcript (no history resurrection)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1)];
    const out = settleTurns({ prev, messages: [], streaming: false, streamStatus: "done", hasIngress: true });
    expect(out).toEqual([]);
  });

  it("leaves active-stream merging untouched (no terminal reconcile)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("user", "two", -1)];
    const messages = [{ role: "assistant", content: "live" }];
    const out = settleTurns({ prev, messages, streaming: true, streamStatus: "streaming", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["live", "two"]);
  });
});

// PR #280 review — reconcile guard precedence (M2) and duplicate-prompt
// anchoring (N1). The reconcile branch must not preempt the error/ephemeral
// preservation branches, and duplicate prompt texts must not resurrect a
// duplicated prefix.
describe("settleTurns — reconcile guard precedence + duplicate prompts (M2/N1)", () => {
  function turn(role: "user" | "assistant", text: string, rawIndex: number): ChatTurn {
    return { role, text, imageCount: 0, rawIndex };
  }
  const errorTurn: ChatTurn = {
    role: "assistant",
    text: "failed",
    imageCount: 0,
    rawIndex: -1,
    error: { code: "PROVIDER_UNREACHABLE", message: "x" },
  };

  it("preserves a frozen error turn a shorter error read lacks (M2)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("user", "two", -1), errorTurn];
    const out = settleTurns({ prev, messages: [{ role: "user", content: "two" }], streaming: false, streamStatus: "error", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "failed"]);
    expect(out?.some((t) => !!t.error)).toBe(true);
  });

  it("preserves the just-sent optimistic user turn when the shorter read predates it (M2)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("user", "two", -1)];
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "reply one" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two"]);
  });

  it("does not resurrect a duplicated prefix when the shorter read already exists (N1)", () => {
    const prev: ChatTurn[] = [
      turn("user", "hello", 0),
      turn("assistant", "hi", 1),
      turn("user", "again", 2),
      turn("assistant", "ok", 3),
      turn("user", "hello", -1),
    ];
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
      { role: "assistant", content: "ok" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => `${t.role}:${t.text}`)).toEqual(["user:hello", "assistant:hi", "user:again", "assistant:ok"]);
  });

  it("does not duplicate an assistant-only tail already present (fallback dedupe)", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1), turn("assistant", "tail", 2)];
    const out = settleTurns({ prev, messages: [{ role: "assistant", content: "reply one" }], streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "tail"]);
  });
});

// b7d5619 re-review: the A8 guard must hold UNCONDITIONALLY — a non-empty
// server read shorter than prev at terminal may never end in bare serverTurns.
// The old `suffixOptimistic` gate rejected a trailing assistant carrying a
// shifted rawIndex (post-reconcile, settled thread, foreign run) and collapsed
// the view. F2/F3 cover the retained stale-read branch's raw index space and
// its over-eager block match.
describe("settleTurns — terminal shorter read never shrinks below prev (F1/F2/F3)", () => {
  function turn(role: "user" | "assistant", text: string, rawIndex: number): ChatTurn {
    return { role, text, imageCount: 0, rawIndex };
  }

  it("keeps the settled history for a post-reconcile read (shifted trailing assistant rawIndex)", () => {
    // prev is the merged snapshot a prior reconcile kept: every turn carries a
    // non-negative rawIndex, so the old suffixOptimistic guard was false.
    const prev: ChatTurn[] = [
      turn("user", "one", 0),
      turn("assistant", "reply one", 1),
      turn("user", "two", 2),
      turn("assistant", "reply two", 3),
      turn("user", "three", 4),
      turn("assistant", "reply three", 5),
    ];
    const messages = [
      { role: "user", content: "three" },
      { role: "assistant", content: "reply three" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "reply two", "three", "reply three"]);
  });

  it("keeps the settled history for a settled thread (trailing persisted assistant, no optimistic suffix)", () => {
    const prev: ChatTurn[] = [
      turn("user", "one", 0),
      turn("assistant", "reply one", 1),
      turn("user", "two", 2),
      turn("assistant", "reply two", 3),
    ];
    const messages = [
      { role: "user", content: "two" },
      { role: "assistant", content: "reply two" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: false });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one", "two", "reply two"]);
  });

  it("returns the merged raw snapshot so kept-prefix indices resolve (start > 0)", () => {
    const rawP0 = { role: "user", content: "p0" };
    const rawP1 = { role: "assistant", content: "p1" };
    const prevRaw = [rawP0, rawP1];
    const prev: ChatTurn[] = [
      turn("user", "p0", 0),
      turn("assistant", "p1", 1),
      turn("user", "hello", 2),
      turn("assistant", "hi", 3),
      turn("user", "hello", -1),
    ];
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = settleTurnsWithRaw({ prev, prevRaw, messages, streaming: false, streamStatus: "done", hasIngress: true });
    // A kept prefix turn's rawIndex must resolve against the returned snapshot —
    // not against the shorter live `messages` (mixed index space).
    const first = out.turns[0]!;
    expect(out.raw[first.rawIndex]).toBe(rawP0);
    expect(out.raw).toEqual([rawP0, rawP1, ...messages]);
  });

  it("keeps persisted history for a shorter error read with no failure of its own", () => {
    const prev: ChatTurn[] = [turn("user", "one", 0), turn("assistant", "reply one", 1)];
    const out = settleTurns({ prev, messages: [{ role: "user", content: "one" }], streaming: false, streamStatus: "error", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["one", "reply one"]);
  });

  it("treats a coincident run-scoped read as a splice, not a stale full read (F3)", () => {
    // The read's [hello, hi] matches prev's earliest block, but it does not
    // reach prev's last user turn (the re-sent "hello") — it is the new run's
    // tail, so other/ok and the new reply must survive.
    const prev: ChatTurn[] = [
      turn("user", "hello", 0),
      turn("assistant", "hi", 1),
      turn("user", "other", 2),
      turn("assistant", "ok", 3),
      turn("user", "hello", -1),
    ];
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = settleTurns({ prev, messages, streaming: false, streamStatus: "done", hasIngress: true });
    expect(out?.map((t) => t.text)).toEqual(["hello", "hi", "other", "ok", "hello", "hi"]);
  });
});
