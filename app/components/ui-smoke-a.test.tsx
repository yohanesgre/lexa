// @vitest-environment jsdom
// The single retained UI smoke: the admin.assistant route gate (redirect/notice,
// no surface while gated) and the tasks route `?swimlane=` filter contract.
// Presentational render suites live nowhere else by design (below-floor trim).
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { createFetchMock, createQueryWrapper, createTestQueryClient } from "../test-utils";

const h = vi.hoisted(() => ({
  session: { value: null as unknown, loading: false },
  pathname: "/admin/assistant",
  search: { value: { task: undefined as string | undefined, swimlane: undefined as string | undefined } },
  navigate: vi.fn(),
  assistantEnabled: true,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, className, style, children }: { to?: string; className?: string; style?: CSSProperties; children?: ReactNode }) => (
    <a href={to} className={className} style={style}>{children}</a>
  ),
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => ({}) }),
  Navigate: () => <div data-testid="navigate-away" />,
  Outlet: () => <div data-testid="outlet" />,
  useNavigate: () => h.navigate,
  useRouterState: () => h.pathname,
  useParams: () => ({ slug: "demo" }),
  useSearch: () => ({}),
}));

vi.mock("../lib/queries", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSession: () => ({ data: h.session.value, isLoading: h.session.loading }),
    // Capability gate — AssistantShell renders the unavailable notice on the
    // Bun flavor (ADR-0003 §F.3).
    useCapabilities: () => ({
      data: { assistant: h.assistantEnabled, flavor: h.assistantEnabled ? "workers" : "bun" },
      isLoading: false,
    }),
  };
});

import { AssistantShell } from "./assistant/AssistantShell";
import { TasksPage } from "./tasks/TasksPage";

describe("admin.assistant shell gating", () => {
  beforeEach(() => {
    h.session.value = null;
    h.session.loading = false;
    h.pathname = "/admin/assistant";
    h.assistantEnabled = true;
  });

  it("renders the tab bar and outlet for a superadmin and marks the active tab by path", () => {
    h.session.value = { user: { role: "superadmin" } };
    const { unmount } = render(<AssistantShell />);
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/admin/assistant");
    expect(screen.getByRole("link", { name: "Providers & Models" })).toHaveAttribute("href", "/admin/assistant/providers");
    expect(screen.getByRole("link", { name: "Agents & Skills" })).toHaveAttribute("href", "/admin/assistant/agents");
    expect(screen.getByRole("link", { name: "Usage & Costs" })).toHaveAttribute("href", "/admin/assistant/usage");
    expect(screen.getByRole("link", { name: "Recent runs" })).toHaveAttribute("href", "/admin/assistant/runs");
    expect(screen.getByRole("link", { name: "Project bindings" })).toHaveAttribute("href", "/admin/assistant/bindings");
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate-away")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
    unmount();

    h.pathname = "/admin/assistant/";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
    cleanup();

    h.pathname = "/admin/assistant/providers";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Providers & Models" }).className).toContain("active");
    expect(screen.getByRole("link", { name: "Agents & Skills" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Usage & Costs" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Recent runs" }).className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Project bindings" }).className).not.toContain("active");
  });

  it("redirects members away from the shell", () => {
    h.session.value = { user: { role: "member" } };
    render(<AssistantShell />);
    expect(screen.getByTestId("navigate-away")).toBeInTheDocument();
    expect(screen.queryByTestId("outlet")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
  });

  it("renders nothing while the session is loading, then the capability-disabled notice on the Bun flavor", () => {
    h.session.loading = true;
    const { container } = render(<AssistantShell />);
    expect(container).toBeEmptyDOMElement();
    cleanup();

    h.session.loading = false;
    h.session.value = { user: { role: "superadmin" } };
    h.assistantEnabled = false;
    render(<AssistantShell />);
    expect(screen.getByText("The Assistant runs on the Cloudflare Workers deployment")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("outlet")).not.toBeInTheDocument();
  });
});

type Wrapper = ComponentType<{ children: ReactNode }>;

describe("tasks route swimlane param", () => {
  const { fetchMock, routes, mockFetch } = createFetchMock();

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
      { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "sp1", title: "Task in Sprint 7", description: "", priority: "pr1", type: "tp1", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
      { id: "t2", projectId: "p1", columnId: "c1", swimlaneId: "sp2", title: "Task in Sprint 8", description: "", priority: "pr1", type: "tp1", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    ],
  };

  let queryClient: QueryClient;
  let wrapper: Wrapper;

  beforeEach(() => {
    h.search.value = { task: undefined, swimlane: undefined };
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    routes.clear();
    mockFetch();
    routes.set("GET /api/projects/demo/board", BOARD);
    routes.set("GET /api/projects/demo/tasks", { data: BOARD.tasks });
    queryClient = createTestQueryClient();
    wrapper = createQueryWrapper(queryClient);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it("?swimlane=sp1 pre-filters the list to that lane; without the param all lanes render", async () => {
    h.search.value = { task: undefined, swimlane: "sp1" };
    render(<TasksPage slug="demo" search={h.search.value!} />, { wrapper });
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Task in Sprint 8")).not.toBeInTheDocument();
    expect(screen.getByText("Sprint: Sprint 7")).toBeInTheDocument();
    expect(screen.getByLabelText("Swimlane filter")).toHaveValue("sp1");
    cleanup();

    h.search.value = { task: undefined, swimlane: undefined };
    render(<TasksPage slug="demo" search={h.search.value!} />, { wrapper });
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.getByText("Task in Sprint 8")).toBeInTheDocument();
  });

  it("param change while mounted syncs the filter state (stale badge avoided)", async () => {
    const { rerender } = render(<TasksPage slug="demo" search={h.search.value!} />, { wrapper });
    await screen.findByText("Task in Sprint 7");
    h.search.value = { task: undefined, swimlane: "sp1" };
    rerender(<TasksPage slug="demo" search={h.search.value!} />);
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Task in Sprint 8")).not.toBeInTheDocument();
    expect(screen.getByText("Sprint: Sprint 7")).toBeInTheDocument();
  });
});
