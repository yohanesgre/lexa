// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Board, FieldOption, Swimlane, Task } from "../../../shared/types";
import { makeBoard as makeBoardFixture } from "../../test-utils";

const h = vi.hoisted(() => ({ milestones: [] as unknown[] }));
const updateMutate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useBoard: vi.fn(),
  useMilestones: () => ({ data: h.milestones }),
  useUpdateSwimlane: () => ({ mutate: updateMutate }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  useCreateColumn: () => ({ mutate: vi.fn() }),
  useArchiveSwimlane: () => ({ mutate: vi.fn() }),
  useRestoreSwimlane: () => ({ mutate: vi.fn() }),
  useCreateSwimlane: () => ({ mutate: vi.fn() }),
  useSession: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

import { useBoard, useSession } from "../../lib/queries";
import { SwimlanesPage } from "./SwimlanesPage";
import { DeleteSwimlaneDialog } from "./DeleteSwimlaneDialog";
import { SwimlaneHeader } from "../kanban/SwimlaneHeader";
import { SwimlaneForm } from "../kanban/SwimlaneForm";
import { OptionSettingsSection } from "../kanban/OptionSettingsSection";

const useBoardMock = vi.mocked(useBoard);
const useSessionMock = vi.mocked(useSession);

const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Sprint 5 — Audio pass", description: "", position: 0, dueAt: null, startAt: null, archivedAt: "2026-07-22", kind: "sprint", milestoneId: null, tasksDone: 9, tasksTotal: 9 };

function archivedTasks(laneId: string, count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${laneId}-t${i}`,
    key: `DEMO-${i}`,
    projectId: "p1",
    columnId: "c1",
    swimlaneId: laneId,
    title: `Task ${i}`,
    description: "",
    priority: "p",
    type: "t",
    assignees: [],
    position: `a${i}`,
    githubs: [],
    dueAt: null,
    archivedAt: "2026-07-22",
    createdAt: "t",
    updatedAt: "t",
  }));
}

function makeBoard(): Board {
  return makeBoardFixture({
    swimlanes: [
      LANE,
      { id: "s2", projectId: "p1", name: "Sprint 4 — Save system", description: "", position: 1, dueAt: null, startAt: null, archivedAt: "2026-07-22", kind: "sprint", milestoneId: null, tasksDone: 0, tasksTotal: 0 },
    ],
    tasks: archivedTasks(LANE.id, 9),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.milestones = [];
  useBoardMock.mockReturnValue({ data: makeBoard(), isLoading: false, error: null, refetch: vi.fn() } as unknown as ReturnType<typeof useBoard>);
  useSessionMock.mockReturnValue({ data: { user: { role: "superadmin" } } } as unknown as ReturnType<typeof useSession>);
});

function laneRow(name: string): HTMLElement {
  return screen.getByText(name).closest(".sl-row") as HTMLElement;
}

describe("SwimlanesPage archived lane progress + delete gating", () => {
  it("keeps the archived lane's progress pill without the ready-to-archive emphasis, and gates Delete on emptiness", () => {
    render(<SwimlanesPage slug="demo" />);
    const archivedRow = laneRow("Sprint 5 — Audio pass");
    expect(within(archivedRow).getByText("9/9 done")).toBeInTheDocument();
    expect(within(archivedRow).queryByText("Ready to archive")).not.toBeInTheDocument();
    expect(within(archivedRow).getByRole("button", { name: /delete/i })).toBeDisabled();
    expect(within(laneRow("Sprint 4 — Save system")).getByRole("button", { name: /delete/i })).toBeEnabled();
  });
});

describe("SwimlanesPage archived-only state", () => {
  it("renders archived lanes in the dimmed lower section, not inside milestone groups", async () => {
    const user = userEvent.setup();
    h.milestones = [{ id: "m1", name: "v1.0 launch", dueAt: null, archivedAt: null, sprintCount: 1, archivedSprintCount: 1 }];
    const board = makeBoard();
    useBoardMock.mockReturnValue({
      data: { ...board, swimlanes: [{ ...LANE, milestoneId: "m1" }], milestones: h.milestones },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBoard>);

    render(<SwimlanesPage slug="demo" />);
    await user.selectOptions(screen.getByLabelText("State filter"), "archived");

    const row = laneRow("Sprint 5 — Audio pass");
    expect(row.closest(".tasks-state-block")).toBeTruthy();
    expect(row.closest(".sl-group")).toBeNull();
  });
});

describe("DeleteSwimlaneDialog copy", () => {
  it("describes an empty lane and explains that a lane with tasks must be emptied first", () => {
    const empty = render(<DeleteSwimlaneDialog target={LANE} taskCount={0} onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/has no tasks/i)).toBeInTheDocument();
    expect(screen.queryByText(/will unassign/i)).not.toBeInTheDocument();
    empty.unmount();

    render(<DeleteSwimlaneDialog target={LANE} taskCount={3} onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/3 tasks\. Reassign them to another swimlane first/i)).toBeInTheDocument();
  });
});

// Merged from components/kanban/ui-gaps-w3.test.tsx — the Backlog-lane payload
// guard (protected fields must never be written back on a backlog save) and the
// in-use option delete guard.
describe("Backlog lane save omits protected fields", () => {
  it("omits protected fields from the header mutate body and the form payload", async () => {
    const user = userEvent.setup();
    updateMutate.mockClear();
    const header = render(
      <SwimlaneHeader
        slug="demo"
        lane={{ ...LANE, archivedAt: null, name: "Backlog", kind: "backlog" }}
        count={0}
        onToggle={vi.fn()}
      />
    );

    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(screen.getByRole("menuitem", { name: /settings/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const body = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ id: "s1", name: "Backlog", description: "" });
    expect(body).not.toHaveProperty("milestoneId");
    expect(body).not.toHaveProperty("dueAt");
    expect(body).not.toHaveProperty("startAt");
    header.unmount();

    const onSubmit = vi.fn();
    render(
      <SwimlaneForm
        slug="demo"
        swimlane={{ ...LANE, archivedAt: null, name: "Backlog", kind: "backlog" }}
        isOpen
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({ name: "Backlog", description: null });
    expect(payload).not.toHaveProperty("dueAt");
    expect(payload).not.toHaveProperty("startAt");
    expect(payload).not.toHaveProperty("milestoneId");
  });
});

describe("OptionSettingsSection in-use guard", () => {
  const options: FieldOption[] = [{ id: "p1", label: "Urgent", color: "#FF4444", position: 0 }];

  it("disables delete when the option is used by tasks and allows it when unused", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const used = render(
      <OptionSettingsSection
        kind="priority"
        title="Priorities"
        description="desc"
        options={options}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onAdd={vi.fn()}
        inUseIds={new Set(["p1"])}
      />
    );
    const del = screen.getByRole("button", { name: /delete priority/i });
    expect(del).toBeDisabled();
    await user.click(del);
    expect(onDelete).not.toHaveBeenCalled();
    used.unmount();

    render(
      <OptionSettingsSection
        kind="priority"
        title="Priorities"
        description="desc"
        options={options}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        inUseIds={new Set()}
      />
    );
    expect(screen.getByRole("button", { name: /delete priority/i })).toBeEnabled();
  });
});
