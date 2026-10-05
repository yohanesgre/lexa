// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import { useApprovalDecisions } from "./assistant-chat-session";
import type { ChatTurn } from "./assistant-chat-utils";
import type { AssistantWriteDiff } from "../../../shared/assistant";

vi.mock("../../lib/api", () => ({
  decideAssistantApproval: vi.fn(),
}));

import * as api from "../../lib/api";

const decideMock = vi.mocked(api.decideAssistantApproval);

const DIFF: AssistantWriteDiff = { type: "task_create", title: "New task", fields: {} };

function chip(overrides: Partial<ApprovalChip> = {}): ApprovalChip {
  return {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "create_task",
    diff: DIFF,
    state: "pending",
    ...overrides,
  };
}

function batchTurn(chips: ApprovalChip[]): ChatTurn {
  return { role: "assistant", text: "proposed", imageCount: 0, rawIndex: 0, batch: { batchId: "b1", chips } };
}

function decision(approvalId: string, status: string) {
  return { approvalId, batchId: "b1", status, remaining: 0 };
}

function renderDecisions(initial: ChatTurn[]) {
  return renderHook(() => {
    const [turns, setTurns] = useState<ChatTurn[] | null>(initial);
    const decisions = useApprovalDecisions({ setTurns });
    return { ...decisions, turns };
  });
}

describe("useApprovalDecisions — reject all", () => {
  it("issues one reject POST per pending chip and never touches decided chips", async () => {
    decideMock.mockReset();
    decideMock.mockImplementation(async (approvalId) => decision(approvalId, "rejected"));
    const chips = [
      chip({ approvalId: "a1", seq: 0, state: "pending" }),
      chip({ approvalId: "a2", seq: 1, state: "approved" }),
      chip({ approvalId: "a3", seq: 2, state: "pending" }),
    ];
    const { result } = renderDecisions([batchTurn(chips)]);

    act(() => result.current.handleRejectAll(result.current.turns![0]!.batch!.chips));

    await waitFor(() => expect(decideMock).toHaveBeenCalledTimes(2));
    expect(decideMock.mock.calls.map((c) => c)).toEqual([
      ["a1", "reject"],
      ["a3", "reject"],
    ]);
    expect(decideMock).not.toHaveBeenCalledWith("a2", expect.anything());
    await waitFor(() =>
      expect(result.current.turns![0]!.batch!.chips.map((c) => c.state)).toEqual(["rejected", "approved", "rejected"])
    );
  });

  it("self-heals a 409 during reject-all via the chip error mapping", async () => {
    decideMock.mockReset();
    decideMock.mockImplementation(async (approvalId) => {
      if (approvalId === "a1") {
        throw Object.assign(new Error("already decided"), {
          code: "APPROVAL_ALREADY_DECIDED",
          details: { status: "approved" },
        });
      }
      return decision(approvalId, "rejected");
    });
    const chips = [chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1 })];
    const { result } = renderDecisions([batchTurn(chips)]);

    act(() => result.current.handleRejectAll(result.current.turns![0]!.batch!.chips));

    await waitFor(() => {
      const states = result.current.turns![0]!.batch!.chips.map((c) => c.state);
      expect(states).toEqual(["approved", "rejected"]);
    });
  });
});

describe("AssistantApprovalBatch — reject all button", () => {
  it("renders Reject all left of Approve all while chips are pending", () => {
    render(
      <AssistantApprovalBatch
        chips={[chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1 })]}
        locked={false}
        onDecide={() => {}}
        onApproveAll={() => {}}
        onRejectAll={() => {}}
      />
    );
    const rejectAll = screen.getByRole("button", { name: "Reject all" });
    const approveAll = screen.getByRole("button", { name: "Approve all" });
    expect(rejectAll.compareDocumentPosition(approveAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rejectAll).toBeEnabled();
  });

  it("disables both batch actions while the batch is locked", () => {
    render(
      <AssistantApprovalBatch
        chips={[chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1 })]}
        locked
        onDecide={() => {}}
        onApproveAll={() => {}}
        onRejectAll={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Reject all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve all" })).toBeDisabled();
  });

  it("offers no batch action once nothing is pending", () => {
    render(
      <AssistantApprovalBatch
        chips={[chip({ approvalId: "a1", seq: 0, state: "approved" }), chip({ approvalId: "a2", seq: 1, state: "rejected" })]}
        locked={false}
        onDecide={() => {}}
        onApproveAll={() => {}}
        onRejectAll={() => {}}
      />
    );
    expect(screen.queryByText("Reject all")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve all")).not.toBeInTheDocument();
  });
});

// Wireframe herald-write-approvals.html → BATCH ACTION VISIBILITY: the header
// batch actions render ONLY when pendingCount >= 2; a single pending chip (a
// single-chip batch, or an all-but-one-decided batch) keeps per-card only.
describe("AssistantApprovalBatch — batch action visibility", () => {
  function renderChips(chips: ApprovalChip[]) {
    return render(
      <AssistantApprovalBatch chips={chips} locked={false} onDecide={() => {}} onApproveAll={() => {}} onRejectAll={() => {}} />
    );
  }

  it("renders NO batch actions for a single-chip batch and keeps the per-card buttons", () => {
    renderChips([chip({ approvalId: "a1", seq: 0 })]);
    expect(screen.queryByRole("button", { name: "Approve all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject all" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve create_task new" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject create_task new" })).toBeInTheDocument();
  });

  it("renders both batch actions at the two-pending boundary", () => {
    renderChips([chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1, name: "move_task" })]);
    expect(screen.getByRole("button", { name: "Approve all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject all" })).toBeInTheDocument();
  });

  it("renders NO batch actions with one pending left in a three-chip batch (per-card only)", () => {
    renderChips([
      chip({ approvalId: "a1", seq: 0, state: "approved" }),
      chip({ approvalId: "a2", seq: 1, name: "move_task", state: "rejected" }),
      chip({ approvalId: "a3", seq: 2, name: "add_comment" }),
    ]);
    expect(screen.queryByRole("button", { name: "Approve all" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject all" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve add_comment new" })).toBeInTheDocument();
  });

  it("renders both batch actions when two or more chips are pending", () => {
    renderChips([chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1, name: "move_task" }), chip({ approvalId: "a3", seq: 2, name: "add_comment" })]);
    expect(screen.getByRole("button", { name: "Approve all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject all" })).toBeInTheDocument();
  });
});
