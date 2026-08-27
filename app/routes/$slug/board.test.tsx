// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BoardPage } from "../../components/kanban/BoardPage";

const searchMock = vi.hoisted(() => ({ value: { task: undefined as string | undefined, milestone: undefined as string | undefined } }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => navigateMock,
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}`} className={className}>{children}</a>
  ),
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MILESTONE = { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 1, archivedSprintCount: 0 };

function makeBoard() {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: "m1" },
      { id: "s2", projectId: "p1", name: "Hack week", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
      { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 2, dueAt: null, archivedAt: null, startAt: null, kind: "backlog", milestoneId: null },
    ],
    milestones: [MILESTONE],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [
      { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Sprint task", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    ],
  };
}

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

function BoardPageWrapper() {
  return <BoardPage slug="demo" search={searchMock.value} />;
}

beforeEach(() => {
  searchMock.value = { task: undefined, milestone: undefined };
  navigateMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/board", makeBoard());
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("board milestone selection", () => {
  it("defaults to the first non-archived milestone (sprints visible)", async () => {
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Hack week")).not.toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("selecting No milestone writes the sentinel and shows loose sprints + Backlog", async () => {
    const user = userEvent.setup();
    const view = render(<BoardPageWrapper />, { wrapper });
    await screen.findByText("Sprint 7");
    await user.click(document.querySelector(".ms-selector-trigger")!);
    await user.click(screen.getByText("No milestone"));
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { milestone: "none" } }));
    // simulate the navigate side effect: the param lands in the URL
    searchMock.value = { task: undefined, milestone: "none" };
    view.rerender(<BoardPageWrapper />);
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("reload with ?milestone=none keeps the loose-sprint choice (no fallback to active milestone)", async () => {
    searchMock.value = { task: undefined, milestone: "none" };
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
  });
});