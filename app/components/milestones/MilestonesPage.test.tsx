// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MilestonesPage } from "./MilestonesPage";
import type { Board, Milestone } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}?${JSON.stringify(search)}`} className={className}>{children}</a>
  ),
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MILESTONES: Milestone[] = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "Public release", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 4, archivedSprintCount: 2 },
  { id: "m2", projectId: "p1", name: "Beta milestone", description: "Closed beta", position: 1, dueAt: "2026-08-10", archivedAt: null, sprintCount: 3, archivedSprintCount: 1 },
  { id: "m3", projectId: "p1", name: "Prototype", description: "", position: 2, dueAt: "2026-06-30", archivedAt: "2026-07-01T00:00:00.000Z", sprintCount: 1, archivedSprintCount: 1 },
];

const COLUMNS = [
  { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
  { id: "c2", projectId: "p1", name: "Done", position: 1, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: true },
];
const LANES = [
  { id: "s1", projectId: "p1", name: "Sprint 7 — Core", description: "", position: 0, dueAt: "2026-08-25", archivedAt: null, startAt: "2026-08-04", kind: "sprint" as const, milestoneId: "m1" },
  { id: "s2", projectId: "p1", name: "Sprint 6 — Ash & Bone", description: "", position: 1, dueAt: "2026-08-01", archivedAt: null, startAt: "2026-07-14", kind: "sprint" as const, milestoneId: "m1" },
  { id: "s5", projectId: "p1", name: "Sprint 5 — Audio", description: "", position: 2, dueAt: "2026-07-21", archivedAt: "2026-08-01T00:00:00.000Z", startAt: "2026-06-30", kind: "sprint" as const, milestoneId: "m1" },
  { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 3, dueAt: null, archivedAt: null, startAt: null, kind: "backlog" as const, milestoneId: null },
];
const TASKS = [
  { id: "t1", key: "EG-1", projectId: "p1", columnId: "c2", swimlaneId: "s1", title: "T1", description: { type: "doc" as const, content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
  { id: "t2", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T2", description: { type: "doc" as const, content: [] }, priority: "p", type: "t", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
  { id: "t3", key: "EG-1", projectId: "p1", columnId: "c2", swimlaneId: "s2", title: "T3", description: { type: "doc" as const, content: [] }, priority: "p", type: "t", assignees: [], position: "a2", githubs: [], dueAt: null, archivedAt: "2026-08-01T00:00:00.000Z", createdAt: "t", updatedAt: "t" },
];

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: COLUMNS,
    swimlanes: LANES,
    milestones: MILESTONES,
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: TASKS,
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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/milestones", { data: MILESTONES });
  routes.set("GET /api/projects/demo/board", makeBoard());
  routes.set("GET /api/auth/get-session", { session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" }, user: { id: "u1", email: "y@lexa.test", name: "Y", role: "superadmin", createdAt: "t", lastSeen: null } });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("MilestonesPage (list tab)", () => {
  it("renders milestones with progress, sprint sub-rows, and archived section", async () => {
    render(<MilestonesPage slug="demo" tab="list" />, { wrapper });
    expect(await screen.findByText("v1.0 launch")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument(); // Current tag on first non-archived
    expect(screen.getByText("Sprints 2/4 archived")).toBeInTheDocument();
    expect(screen.getByText("Tasks 2/3 done")).toBeInTheDocument(); // t1 done-col, t3 archived, t2 not
    expect(screen.getByText("Sprint 7 — Core")).toBeInTheDocument();
    expect(screen.getByText("1/2 done")).toBeInTheDocument(); // s1: t1 done, t2 not
    expect(screen.getByText("Prototype")).toBeInTheDocument();
    expect(await screen.findByText("Restore")).toBeInTheDocument();
  });
  it("archive click fires the cascade archive mutation", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/projects/demo/milestones/m1/archive", { data: { ...MILESTONES[0]!, archivedAt: "2026-08-13T00:00:00.000Z" }, activity: [] });
    render(<MilestonesPage slug="demo" tab="list" />, { wrapper });
    const complete = (await screen.findAllByRole("button", { name: "Complete milestone" }))[0]!;
    await user.click(complete);
    const dialogConfirm = (await screen.findAllByRole("button", { name: "Complete milestone" })).at(-1)!;
    await user.click(dialogConfirm);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/milestones/m1/archive")).length).toBe(1);
    });
  });
});
