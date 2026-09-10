// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Task } from "../../shared/types";
import { TaskDetail } from "./TaskDetail";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => navigateMock,
  useParams: () => ({ slug: "demo" }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TASK: Task = {
  id: "t1",
  key: "EG-18",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "sp1",
  title: "Crash on large board load",
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

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
  navigateMock.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderDetail(overrides: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  return render(
    <TaskDetail
      mode="view"
      from="board"
      task={TASK}
      columns={[]}
      swimlanes={[]}
      fieldConfig={{ priorities: [], types: [] }}
      onClose={vi.fn()}
      onUpdate={vi.fn()}
      {...overrides}
    />,
    { wrapper }
  );
}

describe("TaskDetail expand", () => {
  it("navigates to the full page with the ticket key and origin", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: "Open full page" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$slug/tasks/$taskId",
      params: { slug: "demo", taskId: "EG-18" },
      search: { from: "board" },
    });
  });

  it("hides expand in create mode", () => {
    renderDetail({ mode: "create" });
    expect(screen.queryByRole("button", { name: "Open full page" })).not.toBeInTheDocument();
  });
});
