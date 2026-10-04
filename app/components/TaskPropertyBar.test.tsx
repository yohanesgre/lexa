// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskPropertyBar } from "./TaskPropertyBar";

type BarProps = ComponentProps<typeof TaskPropertyBar>;

const task = {
  id: "t1",
  key: "DEMO-1",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "s1",
  title: "Task",
  description: { type: "doc", content: [] },
  priority: "pr1",
  type: "tp1",
  assignees: [],
  position: "a0",
  githubs: [],
  dueAt: null,
  archivedAt: null,
  createdAt: "t",
  updatedAt: "t",
};

function baseProps(overrides: Record<string, unknown> = {}) {
  const setSelectedColumnId = vi.fn();
  const setSelectedSwimlaneId = vi.fn();
  return {
    props: {
      isCreate: false,
      task,
      columns: [
        { id: "c1", name: "Todo" },
        { id: "c2", name: "Doing" },
      ],
      swimlanes: [
        { id: "s1", name: "Lane A" },
        { id: "s2", name: "Lane B" },
      ],
      milestones: [],
      fieldConfig: { priorities: [], types: [] },
      missingFields: [],
      currentColumnName: "Todo",
      currentSwimlaneName: "Lane A",
      selectedColumnId: "c1",
      setSelectedColumnId,
      selectedSwimlaneId: "s1",
      setSelectedSwimlaneId,
      onUpdate: vi.fn(),
      onMove: vi.fn().mockResolvedValue(undefined),
      createColumnId: "c1",
      setCreateColumnId: vi.fn(),
      createSwimlaneId: "s1",
      setCreateSwimlaneId: vi.fn(),
      createPriority: "pr1",
      setCreatePriority: vi.fn(),
      createType: "tp1",
      setCreateType: vi.fn(),
      createAssignees: [],
      setCreateAssignees: vi.fn(),
      createDueAt: "",
      setCreateDueAt: vi.fn(),
      availableAssignees: [],
      editingAssignees: false,
      setEditingAssignees: vi.fn(),
      ...overrides,
    },
    setSelectedColumnId,
    setSelectedSwimlaneId,
  };
}

describe("TaskPropertyBar column + lane moves", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes a column change through onMove, not onUpdate", () => {
    const { props } = baseProps();
    render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Doing" }));

    expect(props.setSelectedColumnId).toHaveBeenCalledWith("c2");
    expect(props.onMove).toHaveBeenCalledWith("t1", { columnId: "c2", swimlaneId: "s1" });
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("rolls the column selection back when the move is rejected", async () => {
    const { props } = baseProps();
    props.onMove = vi.fn().mockRejectedValue(new Error("nope"));
    render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Doing" }));

    await waitFor(() => expect(props.setSelectedColumnId).toHaveBeenLastCalledWith("c1"));
  });

  it("moves lane-only changes through onMove carrying the current column", () => {
    const { props } = baseProps();
    render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Lane A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Lane B" }));

    expect(props.setSelectedSwimlaneId).toHaveBeenCalledWith("s2");
    expect(props.onMove).toHaveBeenCalledWith("t1", { columnId: "c1", swimlaneId: "s2" });
  });

  it("rolls the lane selection back when the move is rejected", async () => {
    const { props } = baseProps();
    props.onMove = vi.fn().mockRejectedValue(new Error("nope"));
    render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Lane A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Lane B" }));

    await waitFor(() => expect(props.setSelectedSwimlaneId).toHaveBeenLastCalledWith("s1"));
  });

  it("ignores a same-value column selection", () => {
    const { props } = baseProps();
    const { container } = render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    fireEvent.click(container.querySelector(".menu-popover .menu-item.active")!);

    expect(props.onMove).not.toHaveBeenCalled();
    expect(props.setSelectedColumnId).not.toHaveBeenCalled();
  });

  it("ignores a same-value lane selection", () => {
    const { props } = baseProps();
    const { container } = render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Lane A/ }));
    fireEvent.click(container.querySelector(".menu-popover .menu-item.active")!);

    expect(props.onMove).not.toHaveBeenCalled();
    expect(props.setSelectedSwimlaneId).not.toHaveBeenCalled();
  });

  it("does not restore a stale value when a superseded move rejects", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    const onMove = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(undefined);
    const { props } = baseProps({
      columns: [
        { id: "c1", name: "Todo" },
        { id: "c2", name: "Doing" },
        { id: "c3", name: "Review" },
      ],
      onMove,
    });
    render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Doing" }));
    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(props.setSelectedColumnId).toHaveBeenCalledTimes(2));
    rejectFirst!(new Error("nope"));
    await waitFor(() => expect(props.setSelectedColumnId).toHaveBeenCalledTimes(2));
    expect(props.setSelectedColumnId).not.toHaveBeenCalledWith("c1");
  });
});

describe("TaskPropertyBar badge tokens", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("maps known option colors to PHOSPHOR token classes", () => {
    const { props } = baseProps({
      fieldConfig: {
        priorities: [{ id: "pr1", label: "Urgent", color: "#FF4444" }],
        types: [{ id: "tp1", label: "Bug", color: "#FF4444" }],
      },
    });
    const { container } = render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    const badge = container.querySelector(".priority-badge")!;
    expect(badge).toHaveClass("pb-urgent");
    expect(badge.querySelector(".priority-dot")).toHaveClass("priority-urgent");
    expect(container.querySelector(".type-badge")).toHaveClass("type-bug");
  });

  it("renders option rows with the same token classes", () => {
    const { props } = baseProps({
      fieldConfig: {
        priorities: [
          { id: "pr1", label: "Urgent", color: "#FF4444" },
          { id: "pr2", label: "High", color: "#F0C040" },
        ],
        types: [],
      },
    });
    const { container } = render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    fireEvent.click(screen.getByRole("button", { name: "Urgent" }));
    const dots = container.querySelectorAll(".menu-popover .priority-dot");
    expect(dots[0]).toHaveClass("priority-urgent");
    expect(dots[1]).toHaveClass("priority-high");
  });

  it("falls back to neutral token classes for colorless options", () => {
    const { props } = baseProps({
      fieldConfig: {
        priorities: [{ id: "pr1", label: "None", color: "" }],
        types: [{ id: "tp1", label: "Generic", color: "" }],
      },
    });
    const { container } = render(<TaskPropertyBar {...(props as unknown as BarProps)} />);

    const badge = container.querySelector(".priority-badge")!;
    expect(badge).toHaveClass("pb-low");
    expect(badge.querySelector(".priority-dot")).toHaveClass("priority-low");
    expect(container.querySelector(".type-badge")).toHaveClass("type-task");
  });
});
