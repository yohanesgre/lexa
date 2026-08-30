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
});
