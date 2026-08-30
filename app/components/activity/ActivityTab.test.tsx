// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ActivityTab } from "./ActivityTab";
import type { ActivityItem } from "../../../shared/types";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const EVENT: ActivityItem = {
  kind: "event", id: 1, taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null,
  type: "created", message: "Maria created this task", viaHerald: false, createdAt: "2026-01-01T10:00:00.000Z",
};
const AGENT_EVENT: ActivityItem = {
  kind: "event", id: 2, taskId: "t1", actorKind: "agent", actorLabel: "opencode", actorUserId: null,
  type: "moved" as const, message: "opencode updated this task", viaHerald: false, createdAt: "2026-01-02T10:00:00.000Z",
};
const COMMENT: ActivityItem = {
  kind: "comment", id: 9, taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Maria",
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello @Joao" }] }] },
  viaHerald: false, editedAt: null, deletedAt: null, createdAt: "2026-01-03T10:00:00.000Z",
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
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/tasks/t1/activity", { data: [EVENT, AGENT_EVENT, COMMENT], nextCursor: null });
  routes.set("GET /api/projects/demo/members", { data: [{ id: "u1", name: "Maria", email: "maria@lexa.test", role: "admin" }] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function activityCalls(): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("/activity")).length;
}

describe("ActivityTab", () => {
  it("renders events, agent tags, and comments from the query data", async () => {
    render(<ActivityTab slug="demo" taskId="t1" isArchived={false} />, { wrapper });
    expect(await screen.findByText("Maria created this task")).toBeInTheDocument();
    expect(screen.getByText("opencode updated this task")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument(); // agent tag
    expect(screen.getByText("opencode")).toBeInTheDocument(); // agent label
    // comment renders its body text
    expect(await screen.findByText(/hello/)).toBeInTheDocument();
  });
  it("shows the empty state when there is no activity", async () => {
    routes.set("GET /api/projects/demo/tasks/t1/activity", { data: [], nextCursor: null });
    render(<ActivityTab slug="demo" taskId="t1" isArchived={false} />, { wrapper });
    expect(await screen.findByText("No activity yet — be the first to comment")).toBeInTheDocument();
  });
});
