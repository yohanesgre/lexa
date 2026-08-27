// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TasksPage } from "../../components/tasks/TasksPage";

const searchMock = vi.hoisted(() => ({ value: { task: undefined as string | undefined, swimlane: undefined as string | undefined } }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}`} className={className}>{children}</a>
  ),
}));
const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const BOARD = {
  project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [
    { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
    { id: "c2", projectId: "p1", name: "Done", position: 1, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
  ],
  swimlanes: [
    { id: "sp1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
    { id: "sp2", projectId: "p1", name: "Sprint 8", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
  ],
  milestones: [],
  fieldConfig: {
    priorities: [{ id: "pr1", label: "High", color: "#FF4444", position: 0 }],
    types: [{ id: "tp1", label: "Task", color: "#4ADE80", position: 0 }],
  },
  links: [],
  tasks: [
    { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "sp1", title: "Task in Sprint 7", description: { type: "doc", content: [] }, priority: "pr1", type: "tp1", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    { id: "t2", projectId: "p1", columnId: "c1", swimlaneId: "sp2", title: "Task in Sprint 8", description: { type: "doc", content: [] }, priority: "pr1", type: "tp1", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
  ],
};

const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(hit));
  });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  searchMock.value = { task: undefined, swimlane: undefined };
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/board", BOARD);
  routes.set("GET /api/projects/demo/tasks", { data: BOARD.tasks });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("tasks route swimlane param", () => {
  it("?swimlane=sp1 pre-filters the list to that lane", async () => {
    searchMock.value = { task: undefined, swimlane: "sp1" };
    // @ts-expect-error — strict: exactOptional indexedAccess
    render(<TasksPage slug="demo" search={searchMock.value!} />, { wrapper });
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Task in Sprint 8")).not.toBeInTheDocument();
    expect(screen.getByText("Sprint: Sprint 7")).toBeInTheDocument();
    expect(screen.getByLabelText("Swimlane filter")).toHaveValue("sp1");
  });

  it("without the param all lanes render", async () => {
    // @ts-expect-error — strict: exactOptional indexedAccess
    render(<TasksPage slug="demo" search={searchMock.value!} />, { wrapper });
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.getByText("Task in Sprint 8")).toBeInTheDocument();
  });

  it("param change while mounted syncs the filter state (stale badge avoided)", async () => {
    // @ts-expect-error — strict: exactOptional indexedAccess
    const { rerender } = render(<TasksPage slug="demo" search={searchMock.value!} />, { wrapper });
    await screen.findByText("Task in Sprint 7");
    // simulate in-app navigation: ?swimlane=sp1 lands while the page is mounted
    searchMock.value = { task: undefined, swimlane: "sp1" };
    // @ts-expect-error — strict: exactOptional indexedAccess
    rerender(<TasksPage slug="demo" search={searchMock.value!} />);
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Task in Sprint 8")).not.toBeInTheDocument();
    expect(screen.getByText("Sprint: Sprint 7")).toBeInTheDocument();
  });
});