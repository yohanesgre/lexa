// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { HeraldApprovalBatch, ApprovalChipRow, type ApprovalChip } from "./HeraldApprovals";

function chip(overrides: Partial<ApprovalChip> & { diff?: ApprovalChip["diff"] }): ApprovalChip {
  return {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "create_task",
    state: "pending",
    diff: { type: "task_create", title: "New task", fields: {} },
    ...overrides,
  };
}

describe("HeraldApprovalBatch (herald-write-approvals.html)", () => {
  const onDecide = vi.fn();
  const onApproveAll = vi.fn();

  it("task_update renders a Field|Before|After table; task_move renders from→to pills", () => {
    const { container } = render(
      <div>
        <ApprovalChipRow chip={chip({ name: "update_task", diff: { type: "task_update", taskRef: "LEX-31", taskTitle: "T", changes: [{ field: "priority", before: "Medium", after: "High" }, { field: "dueAt", before: null, after: "2026-08-28" }] } })} total={4} mixedBatch={false} disabled={false} onDecide={onDecide} />
        <ApprovalChipRow chip={chip({ name: "move_task", diff: { type: "task_move", taskRef: "LEX-12", taskTitle: "T", fromColumn: "Backlog", toColumn: "In Progress" } })} total={4} mixedBatch={false} disabled={false} onDecide={onDecide} />
      </div>
    );
    expect(container.querySelectorAll(".approval-diff-table tbody tr")).toHaveLength(2);
    expect(container.querySelector(".approval-diff-table")!.textContent).toContain("—");
    expect(container.querySelectorAll(".column-pill")).toHaveLength(2);
    expect(container.textContent).toContain("Backlog");
    expect(container.textContent).toContain("In Progress");
  });

  it("comment shows an honest char counter against the 2,000 cap", () => {
    const body = "x".repeat(1986);
    const { container } = render(
      <ApprovalChipRow chip={chip({ name: "add_comment", diff: { type: "comment", taskRef: "LEX-31", taskTitle: "T", bodyText: body } })} total={1} mixedBatch={false} disabled={false} onDecide={onDecide} />
    );
    expect(container.textContent).toContain("1,986 / 2,000 chars");
  });

  it("terminal states swap buttons for status lines with wireframe copy", () => {
    const { container } = render(
      <div>
        <ApprovalChipRow chip={chip({ state: "approved" })} total={3} mixedBatch={true} disabled={false} onDecide={onDecide} />
        <ApprovalChipRow chip={chip({ state: "rejected", name: "add_comment" })} total={3} mixedBatch={true} disabled={false} onDecide={onDecide} />
        <ApprovalChipRow chip={chip({ state: "expired" })} total={3} mixedBatch={true} disabled={false} onDecide={onDecide} />
        <ApprovalChipRow chip={chip({ state: "failed", error: { code: "WIP_LIMIT_EXCEEDED", message: "Column \"In Progress\" is at its WIP limit (8)." } })} total={3} mixedBatch={true} disabled={false} onDecide={onDecide} />
      </div>
    );
    expect(container.querySelectorAll(".btn")).toHaveLength(0);
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("Rejected");
    expect(container.textContent).toContain("Approval expired — write not executed.");
    expect(container.textContent).toContain("WIP_LIMIT_EXCEEDED");
    expect(container.querySelector(".state-approved")).not.toBeNull();
    expect(container.querySelector(".state-failed")).not.toBeNull();
  });

  it("full-pending batch shows proposal header + seq counters + Approve all; decisions swap the header to a tally", () => {
    const chips = [
      chip({ approvalId: "a1", seq: 0 }),
      chip({ approvalId: "a2", seq: 1, name: "move_task", diff: { type: "task_move", taskRef: "LEX-12", taskTitle: "T", fromColumn: "Backlog", toColumn: "In Progress" } }),
      chip({ approvalId: "a3", seq: 2, name: "add_comment", diff: { type: "comment", taskRef: "LEX-12", taskTitle: "T", bodyText: "note" } }),
    ];
    const pending = render(<HeraldApprovalBatch chips={chips} locked={false} onDecide={onDecide} onApproveAll={onApproveAll} />);
    expect(pending.container.textContent).toContain("Herald proposes 3 changes");
    expect(pending.container.textContent).toContain("1 / 3");
    fireEvent.click(pending.getByRole("button", { name: /approve all/i }));
    expect(onApproveAll).toHaveBeenCalledOnce();

    const mixed = render(
      <HeraldApprovalBatch
        chips={[chips[0]!, { ...chips[1]!, state: "approved" }!, { ...chips[2]!, state: "rejected" }]}
        locked={false}
        onDecide={onDecide}
        onApproveAll={onApproveAll}
      />
    );
    // Tally replaces the title while any chip is pending; decided chips yield
    // their seq counter to state labels.
    expect(mixed.container.textContent).toContain("1 approved · 1 rejected · 1 pending");
    expect(mixed.container.textContent).toContain("pending");
    expect(mixed.container.textContent).not.toContain("/ 3");
  });

  it("decide buttons issue verdicts per chip and disable while locked", () => {
    const c = chip({});
    const free = render(<ApprovalChipRow chip={c} total={1} mixedBatch={false} disabled={false} onDecide={onDecide} />);
    fireEvent.click(free.getByRole("button", { name: "Reject" }));
    expect(onDecide).toHaveBeenCalledWith(c, "reject");
    fireEvent.click(free.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenLastCalledWith(c, "approve");
    free.unmount();

    const locked = render(<ApprovalChipRow chip={c} total={1} mixedBatch={false} disabled={true} onDecide={onDecide} />);
    expect((locked.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  });
});