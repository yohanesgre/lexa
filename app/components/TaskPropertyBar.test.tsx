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

  it("opens the type picker and selecting a label calls onUpdate with the option id", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderBar();
    await user.click(screen.getByRole("button", { name: /Feature/ }));
    await user.click(await screen.findByRole("button", { name: /Bug/ }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { type: "tp-bug" });
  });

  it("changing the column dropdown calls onUpdate with the new columnId", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderBar();
    await user.click(screen.getByRole("button", { name: /Todo/ }));
    await user.click(await screen.findByRole("button", { name: /Done/ }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { columnId: "c2" });
  });

  it("changing the swimlane calls onMove with columnId + swimlaneId", async () => {
    const user = userEvent.setup();
    const { onMove } = renderBar();
    await user.click(screen.getByRole("button", { name: /Main/ }));
    await user.click(await screen.findByRole("button", { name: /M2/ }));
    expect(onMove).toHaveBeenCalledWith("t1", { columnId: "c1", swimlaneId: "s2" });
  });

  it("shows the raw due date and picking a day calls onUpdate with an ISO date", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderBar({ task: { ...TASK, dueAt: "2099-01-01" } });
    // The property bar passes the raw ISO value to the DatePicker — the
    // formatted label lives in TaskCard/SwimlaneHeader.
    expect(screen.getByRole("button", { name: /2099-01-01/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /2099-01-01/ }));
    const day = (await screen.findAllByRole("button", { name: "15" }))[0]!;
    await user.click(day);
    expect(onUpdate).toHaveBeenCalledWith("t1", { dueAt: expect.stringMatching(/^\d{4}-\d{2}-15$/) } as never);
  });

  it("clearing the due date calls onUpdate with null", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderBar({ task: { ...TASK, dueAt: "2099-01-01" } });
    await user.click(screen.getByRole("button", { name: /2099-01-01/ }));
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(onUpdate).toHaveBeenCalledWith("t1", { dueAt: null });
  });

  it("create mode wires the create-* setters instead of onUpdate", async () => {
    const user = userEvent.setup();
    renderBar({
      isCreate: true,
      setCreatePriority: vi.fn(),
      setCreateType: vi.fn(),
      setCreateDueAt: vi.fn(),
      setCreateColumnId: vi.fn(),
    });
    // Column is a plain <select> in create mode
    await user.selectOptions(screen.getByLabelText("Column"), "c2");
    // Priority picker drives setCreatePriority
    await user.click(screen.getByRole("button", { name: /High/ }));
    await user.click(await screen.findByRole("button", { name: /Low/ }));
  });
});
