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
        chips={[chip({ approvalId: "a1", seq: 0 })]}
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
