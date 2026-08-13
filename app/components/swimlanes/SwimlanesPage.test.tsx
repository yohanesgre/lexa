// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SwimlanesPage } from "./SwimlanesPage";
import type { Board } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}?swimlane=${search?.swimlane ?? ""}`} className={className}>{children}</a>
  ),
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MILESTONES = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 2, archivedSprintCount: 1 },
];

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [
      { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
      { id: "c2", projectId: "p1", name: "Done", position: 1, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: true },
    ],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Sprint 7 — Core", description: "", position: 0, dueAt: "2026-08-25", archivedAt: null, startAt: "2026-08-04", kind: "sprint", milestoneId: "m1" },
      { id: "s2", projectId: "p1", name: "Hack week", description: "", position: 1, dueAt: "2026-08-10", archivedAt: null, startAt: "2026-08-03", kind: "sprint", milestoneId: null },
      { id: "s3", projectId: "p1", name: "Sprint 5 — Audio", description: "", position: 2, dueAt: "2026-07-21", archivedAt: "2026-08-01T00:00:00.000Z", startAt: "2026-06-30", kind: "sprint", milestoneId: null },
      { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 3, dueAt: null, archivedAt: null, startAt: null, kind: "backlog", milestoneId: null },
    ],
    milestones: MILESTONES,
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [
      { id: "t1", projectId: "p1", columnId: "c2", swimlaneId: "s1", title: "T1", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
      { id: "t2", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T2", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/board", makeBoard());
  routes.set("GET /api/projects/demo/board?includeArchived=true", makeBoard());
  routes.set("GET /api/projects/demo/milestones", { data: MILESTONES });
  routes.set("GET /api/auth/get-session", { session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" }, user: { id: "u1", email: "y@lexa.test", name: "Y", role: "superadmin", createdAt: "t", lastSeen: null } });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("SwimlanesPage", () => {
  it("groups lanes by milestone, shows progress pills, Backlog system row", async () => {
    render(<SwimlanesPage slug="demo" />, { wrapper });
    expect(await screen.findByText("Sprint 7 — Core")).toBeInTheDocument();
    expect(screen.getByText("milestone · 1/2 sprints archived · Due Sep 21")).toBeInTheDocument();
    expect(screen.getByText("1/2 done")).toBeInTheDocument(); // t1 done col, t2 not
    expect(screen.getAllByText("No milestone").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Hack week")).toBeInTheDocument();
    expect(screen.getAllByText("Backlog").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("system lane")).toBeInTheDocument();
    expect(screen.getAllByText("View tasks").length).toBeGreaterThanOrEqual(3);
  });

  it("view tasks links carry the swimlane search param", async () => {
    render(<SwimlanesPage slug="demo" />, { wrapper });
    await screen.findByText("Sprint 7 — Core");
    const link = screen.getAllByText("View tasks")[0]!.closest("a")!;
    expect(link.getAttribute("href")).toContain("swimlane=s1");
  });

  it("milestone filter narrows the rows", async () => {
    const user = userEvent.setup();
    render(<SwimlanesPage slug="demo" />, { wrapper });
    await screen.findByText("Sprint 7 — Core");
    await user.selectOptions(screen.getByLabelText("Filter by milestone"), "none");
    expect(screen.queryByText("Sprint 7 — Core")).not.toBeInTheDocument();
    expect(screen.getByText("Hack week")).toBeInTheDocument();
  });

  it("archived toggle shows the archived-only view with Restore", async () => {
    const user = userEvent.setup();
    render(<SwimlanesPage slug="demo" />, { wrapper });
    await screen.findByText("Sprint 7 — Core");
    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7 — Core")).not.toBeInTheDocument();
  });

  it("archive row action fires the archive mutation", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/projects/demo/swimlanes/s2/archive", { data: { ...makeBoard().swimlanes[1], archivedAt: "2026-08-13T00:00:00.000Z" }, activity: [] });
    render(<SwimlanesPage slug="demo" />, { wrapper });
    const row = (await screen.findAllByText("Hack week"))[0]!.closest(".sl-row")!;
    const btn = row.querySelector('button:nth-of-type(2)') ?? row.querySelector("button:last-of-type");
    await user.click(btn as HTMLElement);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/swimlanes/s2/archive")).length).toBe(1);
    });
  });
});
