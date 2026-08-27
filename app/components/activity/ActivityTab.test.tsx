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

  it("loads older pages via the cursor", async () => {
    const user = userEvent.setup();
    routes.set("GET /api/projects/demo/tasks/t1/activity", { data: [EVENT], nextCursor: "abc" });
    render(<ActivityTab slug="demo" taskId="t1" isArchived={false} />, { wrapper });
    const button = await screen.findByRole("button", { name: "Load older" });
    routes.set("GET /api/projects/demo/tasks/t1/activity?cursor=abc", { data: [AGENT_EVENT], nextCursor: null });
    await user.click(button);
    await waitFor(() => expect(activityCalls()).toBe(2));
    expect(await screen.findByText("opencode updated this task")).toBeInTheDocument();
  });

  it("replaces the composer with the archived notice for archived tasks", async () => {
    render(<ActivityTab slug="demo" taskId="t1" isArchived />, { wrapper });
    expect(await screen.findByText("Comments are disabled on archived tasks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("the admin member sees the delete action on another user's comment and the DELETE mutation fires", async () => {
    const user = userEvent.setup();
    // The acting identity comes from the session (GET /api/auth/get-session)
    // — the members route then resolves role from it.
    routes.set("GET /api/auth/get-session", {
      session: { id: "s1", userId: "u1", expiresAt: "2026-01-10T10:00:00.000Z", createdAt: "2026-01-01T10:00:00.000Z" },
      user: { id: "u1", email: "maria@lexa.test", name: "Maria", role: "admin", createdAt: "t", lastSeen: null },
    });
    routes.set("DELETE /api/projects/demo/tasks/t1/comments/9", 204);
    queryClient.setQueryData(["task-activity", "demo", "t1"], {
      pages: [{ data: [EVENT, COMMENT], nextCursor: null }],
      pageParams: [null],
    });
    render(<ActivityTab slug="demo" taskId="t1" isArchived={false} />, { wrapper });
    await screen.findByText(/hello/);
    // members route reports the lxk user as admin → can delete others' comments
    // (findByRole: the button appears once the members query resolves)
    await user.click(await screen.findByRole("button", { name: "Delete comment" }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/comments/9"));
      expect(calls).toHaveLength(1);
      expect((calls[0]![1] as RequestInit | undefined)?.method).toBe("DELETE");
    });
    // invariant 6: comment removed from the cache via setQueryData, no refetch
    expect(activityCalls()).toBe(0);
    const pages = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: unknown[] }[] }).pages;
    expect(pages[0]!.data.filter((i) => (i as { kind?: string }).kind === "comment")).toHaveLength(0);
  });
});