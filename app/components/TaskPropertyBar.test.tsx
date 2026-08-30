// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPropertyBar } from "./TaskPropertyBar";
import type { Task } from "../../shared/types";

const FIELD_CONFIG = {
  priorities: [
    { id: "pr-high", label: "High", color: "#FF4444" },
    { id: "pr-low", label: "Low", color: "#6B6560" },
  ],
  types: [
    { id: "tp-feature", label: "Feature", color: "#4ADE80" },
    { id: "tp-bug", label: "Bug", color: "#FF4444" },
  ],
};

const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: { type: "doc", content: [] }, priority: "pr-high", type: "tp-feature",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};

const COLUMNS = [
  { id: "c1", name: "Todo" },
  { id: "c2", name: "Done" },
];
const SWIMLANES = [
  { id: "s1", name: "Main" },
  { id: "s2", name: "M2" },
];

function renderBar(props: Partial<Parameters<typeof TaskPropertyBar>[0]> = {}) {
  const onUpdate = vi.fn();
  const onMove = vi.fn();
  const setSelectedColumnId = vi.fn();
  const setSelectedSwimlaneId = vi.fn();
  const setCreateColumnId = vi.fn();
  const setCreatePriority = vi.fn();
  const setCreateType = vi.fn();
  const setCreateAssignees = vi.fn();
  const setCreateDueAt = vi.fn();
  const setEditingAssignees = vi.fn();
  render(
    <TaskPropertyBar
      isCreate={false}
      task={TASK}
      columns={COLUMNS}
      swimlanes={SWIMLANES}
      fieldConfig={FIELD_CONFIG}
      missingFields={[]}
      currentColumnName="Todo"
      currentSwimlaneName="Main"
      selectedColumnId="c1"
      setSelectedColumnId={setSelectedColumnId}
      selectedSwimlaneId="s1"
      setSelectedSwimlaneId={setSelectedSwimlaneId}
      onUpdate={onUpdate}
      onMove={onMove}
      createColumnId="c1"
      setCreateColumnId={setCreateColumnId}
      createPriority="pr-high"
      setCreatePriority={setCreatePriority}
      createType="tp-feature"
      setCreateType={setCreateType}
      createAssignees={[]}
      setCreateAssignees={setCreateAssignees}
      createDueAt=""
      setCreateDueAt={setCreateDueAt}
      availableAssignees={["Maria"]}
      editingAssignees={false}
      setEditingAssignees={setEditingAssignees}
      {...props}
    />
  );
  return { onUpdate, onMove, setSelectedColumnId, setSelectedSwimlaneId };
}

describe("TaskPropertyBar", () => {
  it("renders column, swimlane, priority, type, and due-date fields", () => {
    renderBar();
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("No due date")).toBeInTheDocument();
    expect(screen.getByText("Assignees")).toBeInTheDocument();
  });
  it("opens the priority picker and selecting a label calls onUpdate with the option id", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderBar();
    await user.click(screen.getByRole("button", { name: /High/ }));
    await user.click(await screen.findByRole("button", { name: /Low/ }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { priority: "pr-low" });
  });
});
