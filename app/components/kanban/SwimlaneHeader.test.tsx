// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SwimlaneHeader } from "./SwimlaneHeader";
import type { Board, Swimlane, ActivityEvent } from "../../../shared/types";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Main", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "sprint" };
const BACKLOG: Swimlane = { id: "s2", projectId: "p1", name: "Backlog", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" };
const BOARD: Board = {
  project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [],
  swimlanes: [LANE, BACKLOG],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [{ id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" }],
};
const ARCHIVED_LANE: Swimlane = { ...LANE, archivedAt: "2026-03-01T00:00:00.000Z" };
const ARCHIVE_EVENT: ActivityEvent = { id: 1, taskId: "t1", actorKind: "agent", actorLabel: "mcp", actorUserId: null, type: "archived", message: "mcp archived this task", viaHerald: false, createdAt: "t" };

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
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function boardCalls(): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("/board")).length;
}

describe("SwimlaneHeader", () => {
  it("renders name, padded task count, and the due chip for an overdue milestone", () => {
    const lane = { ...LANE, dueAt: "2000-01-01" };
    render(<SwimlaneHeader slug="demo" lane={lane} count={7} onToggle={() => {}} />, { wrapper });
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("007")).toBeInTheDocument();
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });
  it("toggles collapse via the chevron button", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SwimlaneHeader slug="demo" lane={LANE} count={1} collapsed={false} onToggle={onToggle} />, { wrapper });
    await user.click(screen.getByRole("button", { name: "Collapse swimlane" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
