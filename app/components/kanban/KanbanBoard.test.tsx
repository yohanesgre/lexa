// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { KanbanBoard } from "./KanbanBoard";
import type { Board, Column, Task } from "../../../shared/types";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const COL1: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: 1, requiredFields: [], githubState: null, isDone: false };
const COL2: Column = { id: "c2", projectId: "p1", name: "Done", position: 1, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
const NEW_COL: Column = { id: "c9", projectId: "p1", name: "Review", position: 2, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false };

const TASK1: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task One",
  description: { type: "doc", content: [] }, priority: "p1", type: "t1",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};
const TASK2: Task = {
  id: "t2", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task Two",
  description: { type: "doc", content: [] }, priority: "p1", type: "t1",
  assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};

function makeBoard(columns: Column[], lanes: Board["swimlanes"], tasks: Task[]): Board {
  return {
    project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns,
    swimlanes: lanes,
    milestones: [],
    fieldConfig: {
      priorities: [{ id: "p1", label: "High", color: "#FF4444", position: 0 }],
      types: [{ id: "t1", label: "Feature", color: "#4ADE80", position: 0 }],
    },
    links: [],
    tasks,
  };
}

const LANE: Board["swimlanes"][number] = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" };
const ARCHIVED_LANE: Board["swimlanes"][number] = { ...LANE, id: "s2", name: "Old Sprint", position: 1, kind: "sprint", archivedAt: "2026-03-01T00:00:00.000Z" };

// Per-route counter for the settings modal's data queries (columns/swimlanes/field-config).
function settingsCalls(): Array<{ url: string; method: string }> {
  return fetchMock.mock.calls
    .map((c) => ({ url: String(c[0]), method: (c[1] as RequestInit | undefined)?.method ?? "GET" }))
    .filter((c) => c.url.endsWith("/columns") || c.url.endsWith("/swimlanes") || c.url.endsWith("/field-config"));
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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  // The settings modal's data hooks now live in SettingsContent, which mounts
  // only when the modal is open — the routes are mocked here for the
  // modal-open test, and MUST NOT fire on a plain board mount.
  routes.set("GET /api/projects/demo/columns", { data: [COL1] });
  routes.set("GET /api/projects/demo/swimlanes", { data: [LANE] });
  routes.set("GET /api/projects/demo/field-config", { priorities: [], types: [] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("KanbanBoard", () => {
  it("renders lanes, columns, WIP badges, and task cards from the board prop", () => {
    const board = makeBoard([COL1, COL2], [LANE], [TASK1, TASK2]);
    render(<KanbanBoard board={board} onMoveTask={vi.fn()} onSelectTask={vi.fn()} onOpenCreateTask={vi.fn()} onToggleArchived={vi.fn()} />, { wrapper });
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("Task Two")).toBeInTheDocument();
    // c1 has wipLimit 1 and 2 tasks → exceeded badge "02/01"
    expect(screen.getByText("02/01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument(); // padded column count
    // Fixed: the settings modal's hooks live in SettingsContent (mounted only
    // when open) — a plain board mount fires ZERO settings GETs.
    expect(settingsCalls()).toEqual([]);
  });
  it("opening Settings mounts the modal and fetches columns/field-config on demand", async () => {
    const user = userEvent.setup();
    const board = makeBoard([COL1, COL2], [LANE], [TASK1]);
    render(<KanbanBoard board={board} onMoveTask={vi.fn()} onSelectTask={vi.fn()} onOpenCreateTask={vi.fn()} onToggleArchived={vi.fn()} />, { wrapper });
    expect(settingsCalls()).toEqual([]); // nothing before opening

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Board Settings")).toBeInTheDocument();
    await waitFor(() => {
      const calls = settingsCalls();
      expect(calls.filter((c) => c.url.endsWith("/columns"))).toHaveLength(1);
      expect(calls.filter((c) => c.url.endsWith("/field-config"))).toHaveLength(1);
    });
    // settings content renders from the fetched data
    expect(await screen.findByText("Priorities")).toBeInTheDocument();
    expect(screen.getByText("Types")).toBeInTheDocument();
  });
});
