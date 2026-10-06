// @vitest-environment jsdom
// A task created through the board mutation is cached as a full Task (doc
// present) while the detail query is pending — opening it must surface that
// cached doc via the boardTaskToTask fallback, not an empty one.
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Board, BoardTask, Task, TipTapDoc } from "../../../shared/types";
import { makeBoard } from "../../test-utils";

const state = vi.hoisted(() => ({
  board: undefined as Board | undefined,
  task: undefined as Task | undefined,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useBoard: () => ({ data: state.board, isLoading: false, error: undefined }),
  useSwimlanes: () => ({ data: [] }),
  useTask: () => ({ data: state.task }),
  useMoveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateTask: () => ({ mutate: vi.fn() }),
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteTask: () => ({ mutateAsync: vi.fn() }),
  useArchiveTask: () => ({ mutateAsync: vi.fn() }),
  useRestoreTask: () => ({ mutateAsync: vi.fn() }),
  useLinkGithubIssue: () => ({ mutateAsync: vi.fn() }),
  useUnlinkGithubIssue: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("./KanbanBoard", () => ({ KanbanBoard: () => null }));

vi.mock("../TaskDetail", () => ({
  TaskDetail: ({ task }: { task?: { description: TipTapDoc } }) => (
    <div data-testid="task-detail">
      {task?.description.content.map((node, i) => (
        <span key={i}>{node.content?.map((child) => child.text ?? "").join("")}</span>
      ))}
    </div>
  ),
}));

import { BoardPage } from "./BoardPage";

const CACHED_DOC: TipTapDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Cached body" }] }],
};

const DETAIL_DOC: TipTapDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Detail body" }] }],
};

const CACHED_ROW = {
  id: "t1",
  key: "DEMO-1",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "s1",
  title: "Task",
  priority: "prio-1",
  type: "type-1",
  assignees: [],
  position: "a0",
  githubs: [],
  dueAt: null,
  archivedAt: null,
  createdAt: "t",
  updatedAt: "t",
  description: CACHED_DOC,
} as unknown as BoardTask;

describe("BoardPage cached-description fallback", () => {
  it("surfaces the cached board doc while the detail query is pending", async () => {
    state.task = undefined;
    state.board = makeBoard({ tasks: [CACHED_ROW] });
    render(<BoardPage slug="demo" search={{ task: "t1" }} />);
    expect(await screen.findByTestId("task-detail")).toHaveTextContent("Cached body");
  });

  it("falls back to the empty doc for a board row without a description", async () => {
    state.task = undefined;
    state.board = makeBoard({ tasks: [{ ...CACHED_ROW, description: undefined } as unknown as BoardTask] });
    render(<BoardPage slug="demo" search={{ task: "t1" }} />);
    expect(await screen.findByTestId("task-detail")).toBeEmptyDOMElement();
  });

  it("prefers the resolved detail task over the cached board row", async () => {
    state.task = { ...(CACHED_ROW as unknown as Task), description: DETAIL_DOC };
    state.board = makeBoard({ tasks: [CACHED_ROW] });
    render(<BoardPage slug="demo" search={{ task: "t1" }} />);
    expect(await screen.findByTestId("task-detail")).toHaveTextContent("Detail body");
  });
});
