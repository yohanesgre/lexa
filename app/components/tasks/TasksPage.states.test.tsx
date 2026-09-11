// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TasksPage } from "./TasksPage";

const state = vi.hoisted(() => ({ mode: "loading" as "loading" | "error" }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useTasks: () =>
    state.mode === "loading"
      ? { board: undefined, tasks: undefined, isLoading: true, error: null, refetch: vi.fn() }
      : { board: undefined, tasks: undefined, isLoading: false, error: new Error("boom"), refetch: vi.fn() },
  useBoard: () => ({ data: undefined }),
  useTask: () => ({ data: undefined }),
  useMoveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useArchiveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useLinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUnlinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("../TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

describe("TasksPage loading skeleton", () => {
  afterEach(cleanup);

  it("includes the filter bar and the wireframe row widths", () => {
    state.mode = "loading";
    render(<TasksPage slug="demo" search={{}} />);

    expect(document.querySelector(".tasks-page .tasks-filter")).not.toBeNull();
    const widths = Array.from(document.querySelectorAll(".tasks-list .card-row .skeleton")).map(
      (el) => (el as HTMLElement).style.width
    );
    expect(widths).toEqual(["55%", "49%", "58%", "43%", "52%"]);
  });
});

describe("TasksPage load error", () => {
  afterEach(cleanup);

  it("renders the Network error copy, never the empty state", () => {
    state.mode = "error";
    render(<TasksPage slug="demo" search={{}} />);

    expect(screen.getByText("Failed to load tasks")).toBeInTheDocument();
    expect(screen.getByText("Network error")).toBeInTheDocument();
    expect(document.querySelector(".tasks-error-sub")?.textContent).toContain("the board query failed to load");
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  });
});
