import { describe, expect, it } from "vitest";
import { carryKnownDecisions, settleTurns } from "./assistant-chat-turns-state";
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
