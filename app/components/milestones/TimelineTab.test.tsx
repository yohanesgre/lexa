// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TimelineTab } from "./TimelineTab";
import { DAY_WIDTH_PX } from "../../lib/gantt";
import type { Board, Milestone, Swimlane } from "../../../shared/types";

// jsdom lacks ResizeObserver; GanttChart uses it for fill-to-width sizing.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = RO;
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Sprint 7 — Core", description: "", position: 0, dueAt: "2026-08-25", archivedAt: null, startAt: "2026-08-04", kind: "sprint", milestoneId: "m1" };
const MILESTONES: Milestone[] = [{ id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 1, archivedSprintCount: 0 }];

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [],
    swimlanes: [LANE],
    milestones: MILESTONES,
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [],
  };
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(["board", "demo", false], makeBoard());
  queryClient.setQueryData(["board", "demo", true], makeBoard());
  queryClient.setQueryData(["milestones", "demo"], MILESTONES);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("TimelineTab optimistic drag", () => {
  it("writes the dragged dates to the cache immediately (before the server responds)", async () => {
    // Never-resolving PATCH — optimistic state must already be visible.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(init?.method) === "PATCH" && url.includes("/swimlanes/s1")) {
        return new Promise<Response>(() => {});
      }
      return Promise.reject(new Error(`unmocked: ${init?.method} ${url}`));
    });
    render(<TimelineTab slug="demo" board={makeBoard()} milestones={MILESTONES} />, { wrapper });
    const bar = screen.getByTitle(/Sprint 7 — Core/).closest(".tl-bar")! as HTMLElement;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerDown(bar, { clientX: 100 });
    fireEvent.pointerMove(bar, { clientX: 100 + 5 * DAY_WIDTH_PX });
    fireEvent.pointerUp(bar);
    const cached = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(cached.swimlanes[0]!.startAt).toBe("2026-08-09");
    expect(cached.swimlanes[0]!.dueAt).toBe("2026-08-30");
    vi.restoreAllMocks();
  });

  it("rolls the dates back when the PATCH fails", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (String(init?.method) === "PATCH" && url.includes("/swimlanes/s1")) {
        return Promise.resolve(json({ error: { code: "INVALID_ARGS", message: "start > due" } }, 400));
      }
      return Promise.reject(new Error(`unmocked: ${init?.method} ${url}`));
    });
    render(<TimelineTab slug="demo" board={makeBoard()} milestones={MILESTONES} />, { wrapper });
    const bar = screen.getByTitle(/Sprint 7 — Core/).closest(".tl-bar")! as HTMLElement;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerDown(bar, { clientX: 100 });
    fireEvent.pointerMove(bar, { clientX: 100 + 5 * DAY_WIDTH_PX });
    fireEvent.pointerUp(bar);
    await waitFor(() => {
      const cached = queryClient.getQueryData<Board>(["board", "demo", false])!;
      expect(cached.swimlanes[0]!.startAt).toBe("2026-08-04");
      expect(cached.swimlanes[0]!.dueAt).toBe("2026-08-25");
    });
    vi.restoreAllMocks();
  });
});
