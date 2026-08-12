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

const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Main", description: "", position: 0, dueAt: null, archivedAt: null, kind: "milestone" };
const BACKLOG: Swimlane = { id: "s2", projectId: "p1", name: "Backlog", description: "", position: 1, dueAt: null, archivedAt: null, kind: "backlog" };
const BOARD: Board = {
  project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [],
  swimlanes: [LANE, BACKLOG],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [{ id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" }],
};
const ARCHIVED_LANE: Swimlane = { ...LANE, archivedAt: "2026-03-01T00:00:00.000Z" };
const ARCHIVE_EVENT: ActivityEvent = { id: 1, taskId: "t1", actorKind: "agent", actorLabel: "mcp", actorUserId: null, type: "archived", message: "mcp archived this task", createdAt: "t" };

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

  it("backlog lane shows the system-lane marker and no Archive item", async () => {
    const user = userEvent.setup();
    render(<SwimlaneHeader slug="demo" lane={BACKLOG} count={0} onToggle={() => {}} />, { wrapper });
    expect(screen.getByText("system lane")).toBeInTheDocument();
    await user.click(screen.getByTitle("Swimlane menu"));
    expect(screen.queryByRole("button", { name: "Archive swimlane" })).not.toBeInTheDocument();
  });

  it("archive flow: mutation fires once and the board cache updates from the response — zero refetch", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/projects/demo/swimlanes/s1/archive", { data: ARCHIVED_LANE, activity: [ARCHIVE_EVENT] });
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const view = render(<SwimlaneHeader slug="demo" lane={LANE} count={1} onToggle={() => {}} />, { wrapper });

    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(await screen.findByRole("button", { name: "Archive swimlane" }));

    await waitFor(() => {
      const archiveCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/archive"));
      expect(archiveCalls).toHaveLength(1);
    });
    // Invariant 6: cache updated via setQueryData from the response, no refetch.
    expect(boardCalls()).toBe(0);
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.swimlanes[0]!.archivedAt).toBe(ARCHIVED_LANE.archivedAt);
    expect(live.tasks[0]!.archivedAt).toBe(ARCHIVED_LANE.archivedAt);
    // A lane re-rendered with archivedAt shows the Restore item instead
    view.rerender(<SwimlaneHeader slug="demo" lane={ARCHIVED_LANE} count={0} />);
    await user.click(screen.getByTitle("Swimlane menu"));
    expect(await screen.findByRole("button", { name: "Restore swimlane" })).toBeInTheDocument();
  });

  it("restore flow updates the board cache from the response", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/projects/demo/swimlanes/s1/restore", { data: LANE, activity: [] });
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, swimlanes: [ARCHIVED_LANE] });
    render(<SwimlaneHeader slug="demo" lane={ARCHIVED_LANE} count={0} />, { wrapper });

    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(await screen.findByRole("button", { name: "Restore swimlane" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/restore"))).toHaveLength(1);
    });
    expect(boardCalls()).toBe(0);
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.swimlanes[0]!.archivedAt).toBeNull();
  });

  it("rename flow: PATCH fires and the board cache carries the new name", async () => {
    const user = userEvent.setup();
    const renamed = { ...LANE, name: "Renamed" };
    routes.set("PATCH /api/projects/demo/swimlanes/s1", renamed);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    render(<SwimlaneHeader slug="demo" lane={LANE} count={1} onToggle={() => {}} />, { wrapper });

    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Rename swimlane");
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/swimlanes/s1"))).toHaveLength(1);
    });
    expect(boardCalls()).toBe(0);
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.swimlanes[0]!.name).toBe("Renamed");
  });

  it("delete flow: confirm dialog, then DELETE mutation fires", async () => {
    const user = userEvent.setup();
    routes.set("DELETE /api/projects/demo/swimlanes/s1", 204);
    render(<SwimlaneHeader slug="demo" lane={LANE} count={1} onToggle={() => {}} />, { wrapper });

    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(await screen.findByRole("button", { name: "Delete swimlane" }));
    // The dialog title uses typographic quotes: Delete ‘Main’?
    expect(screen.getByText((c) => c.includes("Delete") && c.includes("Main") && c.includes("?"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/swimlanes/s1"))).toHaveLength(1);
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/swimlanes/s1"))!;
    expect((call[1] as RequestInit | undefined)?.method).toBe("DELETE");
    // cancel path: reopen + cancel leaves the lane alone
    await user.click(screen.getByTitle("Swimlane menu"));
    await user.click(await screen.findByRole("button", { name: "Delete swimlane" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText((c) => c.includes("Delete") && c.includes("Main") && c.includes("?"))).not.toBeInTheDocument();
  });
});
