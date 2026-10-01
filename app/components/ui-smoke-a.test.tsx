// @vitest-environment jsdom
// Presentational-render smoke tests for lane app-smoke-a (settings / assistant /
// wiki / routes scope). Each describe ports one former test file verbatim;
// interactions, stateful hooks, and mock-call assertions live elsewhere.
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Attachment } from "../../shared/types";
import type { AssistantByModelRow, AssistantUsageSummary } from "../lib/assistant-usage.query";
import { createFetchMock, createQueryWrapper, createTestQueryClient } from "../test-utils";

const h = vi.hoisted(() => ({
  session: { value: null as unknown, loading: false },
  teams: [] as unknown[],
  teamMembers: [] as unknown[],
  workspaceMembers: [] as unknown[],
  dashboard: undefined as unknown,
  rateLimit: undefined as unknown,
  revisions: { data: [] as unknown[], isLoading: false, error: null as unknown },
  wikiAttachments: [] as Attachment[],
  providers: [] as unknown[],
  mcpServers: [] as unknown[],
  managedSecrets: false as boolean | undefined,
  bindings: [] as unknown[],
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
  const actual = await importOriginal<typeof import("../lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: h.session.value, isLoading: h.session.loading }),
    useTeams: () => ({ data: h.teams, isLoading: false }),
    useTeamMembers: () => ({ data: h.teamMembers, isLoading: false }),
    useWorkspaceMembers: () => ({ data: h.workspaceMembers }),
    useDashboard: () => ({ data: h.dashboard }),
    useRateLimit: () => ({ data: h.rateLimit, isLoading: false, isError: false }),
    useRevisions: () => h.revisions,
    useWikiAttachments: () => ({ data: h.wikiAttachments }),
    useDeleteAttachment: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // Capability gate — AssistantShell renders the unavailable notice on the
    // Bun flavor (ADR-0003 §F.3).
    useCapabilities: () => ({
      data: { assistant: h.assistantEnabled, flavor: h.assistantEnabled ? "workers" : "bun" },
      isLoading: false,
    }),
  };
});

vi.mock("../lib/queries/assistant-admin", () => ({
  useAssistantProviders: () => ({ data: h.providers, isLoading: false, secretsEnabled: true }),
  useTestProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchModels: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useMcpServers: () => ({ data: h.mcpServers, isLoading: false }),
  useMcpManagedSecrets: () => ({ data: h.managedSecrets }),
  useCreateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useTestMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useAssistantJevConfig: () => ({
    data: {
      config: { id: "default", baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, hasKey: false, keyMask: null, createdAt: "t", updatedAt: "t" },
      secretsEnabled: true,
    },
    isLoading: false,
  }),
  useUpdateAssistantJevConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useTestAssistantJev: () => ({ mutate: vi.fn(), isPending: false }),
  useAssistantBindings: () => ({ data: h.bindings, isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock("../lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock("./wiki/WikiEditor", () => ({ WikiEditor: () => null }));

import { TeamSettings } from "./settings/TeamSettings";
import { ApiKeyRevealModal, RateLimitSection } from "./settings/SettingsSections";
import { UsageByModelTable } from "./assistant/UsageByModelTable";
import { UsageKpiCards } from "./assistant/UsageKpiCards";
import { WikiEditSplit } from "./wiki/WikiEditSplit";
import { AssistantShell } from "../routes/admin.assistant";
import { AssistantProvidersTab } from "../routes/admin.assistant.providers";
import { AssistantBindingsTable } from "./assistant/admin/AssistantBindingsTable";
import { TasksPage } from "./tasks/TasksPage";

describe("UsageByModelTable", () => {
  const row = (over: Partial<AssistantByModelRow> & { model: string }): AssistantByModelRow => ({
    tokens: 0,
    costCents: 0,
    costUsd: 0,
    avgLatencyMs: null,
    calls: 0,
    errorRate: 0,
    ...over,
  });

  function bodyRows(): HTMLTableRowElement[] {
    return Array.from(document.querySelectorAll("tbody tr")) as HTMLTableRowElement[];
  }

  it("renders zero-call rows muted/italic with — placeholders and Calls 0", () => {
    render(<UsageByModelTable byModel={[row({ model: "meta-llama/llama-4-maverick" })]} />);
    const tr = bodyRows()[0]!;
    const cells = Array.from(tr.querySelectorAll("td")) as HTMLTableCellElement[];
    const modelCell = cells[0]!;
    expect(modelCell.textContent).toBe("meta-llama/llama-4-maverick");
    expect(modelCell.style.fontStyle).toBe("italic");
    expect(modelCell.className).toContain("color-muted");
    expect(cells[1]!.textContent).toBe("—");
    expect(cells[2]!.textContent).toBe("—");
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[4]!.textContent).toBe("0");
    expect(cells[5]!.textContent).toBe("—");
  });

  it("sorts rows by tokens DESC", () => {
    render(
      <UsageByModelTable
        byModel={[
          row({ model: "small", tokens: 100, calls: 1, costUsd: 1 }),
          row({ model: "big", tokens: 900, calls: 2, costUsd: 9 }),
        ]}
      />,
    );
    const models = bodyRows().map((tr) => tr.querySelector("td")!.textContent);
    expect(models).toEqual(["big", "small"]);
  });

  it("renders the empty state when there is no data", () => {
    render(<UsageByModelTable byModel={[]} summary={null} />);
    expect(screen.getByText("No usage for this window")).toBeTruthy();
  });
});

describe("UsageKpiCards latency", () => {
  function summary(overrides: Partial<AssistantUsageSummary> = {}): AssistantUsageSummary {
    return {
      totalTokens: 1_482_391,
      promptTokens: 892_100,
      completionTokens: 590_291,
      totalCostCents: 4218,
      totalCostUsd: 42.18,
      avgLatencyMs: 1240,
      p50LatencyMs: 890,
      p95LatencyMs: 2410,
      errorRate: 0.008,
      totalCalls: 1482,
      errorCalls: 12,
      ...overrides,
    };
  }

  it("renders the real p50/p95 values (admin-assistant-usage.html:55)", () => {
    render(<UsageKpiCards summary={summary()} />);
    expect(screen.getByText("p50 890 · p95 2,410 ms")).toBeInTheDocument();
    expect(screen.getByText("1,240 ms")).toBeInTheDocument();
  });

  it("falls back to em dashes when percentiles are null", () => {
    render(<UsageKpiCards summary={summary({ avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null })} />);
    expect(screen.getByText("p50 — · p95 — ms")).toBeInTheDocument();
  });
});

describe("TeamSettings", () => {
  const wrapper = () => createQueryWrapper(createTestQueryClient(), { toast: true, teamSelection: true });

  beforeEach(() => {
    h.dashboard = undefined;
    h.teams = [{ id: "team-1", name: "Core", slug: "core", createdAt: "2026-01-01T00:00:00Z" }];
    h.teamMembers = [];
    h.workspaceMembers = [];
    h.session.value = { user: { role: "member" }, session: { userId: "u-me" } };
  });

  it("Projects table shows Health and Tasks columns", () => {
    h.dashboard = {
      projects: [{
        project: { id: "p1", name: "Emberfall", slug: "emberfall", key: "EMB", description: "", repos: [], createdAt: "", updatedAt: "", teamId: "team-1" },
        taskCount: 42,
        columnCount: 4,
        urgentCount: 0,
        syncCount: 0,
        health: "exceeded",
        wipSegments: [],
      }],
      stats: { totalTasks: 42, activeProjects: 1, wipExceeded: 1, outOfSync: 0 },
      urgentTasks: [],
      outOfSyncTasks: [],
    };

    render(<TeamSettings />, { wrapper: wrapper() });

    expect(screen.getByRole("columnheader", { name: "Health" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("needs attention")).toBeInTheDocument();
    expect(screen.getByText("042")).toBeInTheDocument();
  });

  it("add-member row has no inline role select or Add button", () => {
    render(<TeamSettings />, { wrapper: wrapper() });
    expect(screen.getByLabelText("Add member by email")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add$/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
  });
});

describe("RateLimitSection", () => {
  const wrapper = () => createQueryWrapper(createTestQueryClient(), { toast: true });

  beforeEach(() => {
    h.rateLimit = undefined;
  });

  it("names the /api surface in the description", () => {
    h.rateLimit = { max: 6000, windowMs: 600000, envOverride: false };
    render(<RateLimitSection />, { wrapper: wrapper() });
    expect(screen.getByText(/Applies to all API requests/)).toBeInTheDocument();
  });
});

describe("ApiKeyRevealModal", () => {
  const wrapper = () => createQueryWrapper(createTestQueryClient(), { toast: true });

  it("makes the revealed key selectable as a manual-copy fallback", () => {
    const { container } = render(<ApiKeyRevealModal name="Hermes Staging" fullKey="lxk_abc123" onDone={vi.fn()} />, { wrapper: wrapper() });
    const code = container.querySelector("code") as HTMLElement;
    expect(code).toHaveTextContent("lxk_abc123");
    expect(code.style.userSelect).toBe("all");
  });
});

describe("WikiEditSplit last-edited author", () => {
  const base = {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
  };

  function attachment(overrides: Partial<Attachment>): Attachment {
    return {
      id: "a1",
      projectId: "p1",
      taskId: null,
      wikiPageId: "wp1",
      filename: "whiteboard-sketch.png",
      mimeType: "image/png",
      sizeBytes: 86016,
      sha256: "abc",
      uploadedBy: "u1",
      uploadedByLabel: "Al",
      createdAt: "2026-08-20T10:00:00.000Z",
      ...overrides,
    };
  }

  function setAttachments(next: Attachment[]) {
    h.wikiAttachments = next;
  }

  function renderSplit(overrides: { updatedByName?: string | null; isSaving?: boolean; lastSavedLabel?: string } = {}) {
    return render(
      <WikiEditSplit
        editor={null}
        slug="demo"
        pageSlug="api-reference"
        previewContent={base}
        isSaving={overrides.isSaving ?? false}
        isDirty={false}
        lastSavedAt={null}
        lastSavedLabel={overrides.lastSavedLabel ?? "Last edited just now"}
        updatedByName={overrides.updatedByName ?? null}
        onReviewStateChange={vi.fn()}
      />
    );
  }

  beforeEach(() => {
    h.session.value = { session: { userId: "u1" }, user: { id: "u1", role: "member" } };
    h.wikiAttachments = [];
  });

  it("appends the author name when present", () => {
    renderSplit({ lastSavedLabel: "Last edited 2 hours ago", updatedByName: "Al" });
    expect(screen.getByText("Last edited 2 hours ago by Al")).toBeInTheDocument();
  });

  it("omits the author while a save is in flight", () => {
    renderSplit({ lastSavedLabel: "Saving…", updatedByName: "Al", isSaving: true });
    expect(screen.queryByText(/by Al/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
  });

  it("omits the author when unknown", () => {
    renderSplit({ lastSavedLabel: "Last edited just now", updatedByName: null });
    expect(screen.getByText("Last edited just now")).toBeInTheDocument();
  });

  it("renders file chips with size and a remove action for the uploader", () => {
    setAttachments([attachment({})]);
    renderSplit();
    expect(screen.getByText("Attachments")).toBeInTheDocument();
    expect(screen.getByText("whiteboard-sketch.png")).toBeInTheDocument();
    expect(screen.getByText("84 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove attachment" })).toBeInTheDocument();
  });

  it("hides the remove action for a non-uploader non-admin", () => {
    setAttachments([attachment({ uploadedBy: "u9", uploadedByLabel: "Someone" })]);
    renderSplit();
    expect(screen.getByText("whiteboard-sketch.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove attachment" })).toBeNull();
  });

  it("renders nothing when the page has no attachments", () => {
    setAttachments([]);
    renderSplit();
    expect(screen.queryByText("Attachments")).toBeNull();
  });
});

describe("admin.assistant shell gating", () => {
  beforeEach(() => {
    h.session.value = null;
    h.session.loading = false;
    h.pathname = "/admin/assistant";
    h.assistantEnabled = true;
  });

  it("renders the tab bar and the outlet for a superadmin", () => {
    h.session.value = { user: { role: "superadmin" } };
    render(<AssistantShell />);
    expect(screen.getByText("Assistant")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/admin/assistant");
    expect(screen.getByRole("link", { name: "Providers & Models" })).toHaveAttribute("href", "/admin/assistant/providers");
    expect(screen.getByRole("link", { name: "Agents & Skills" })).toHaveAttribute("href", "/admin/assistant/agents");
    expect(screen.getByRole("link", { name: "Usage & Costs" })).toHaveAttribute("href", "/admin/assistant/usage");
    expect(screen.getByRole("link", { name: "Recent runs" })).toHaveAttribute("href", "/admin/assistant/runs");
    expect(screen.getByRole("link", { name: "Project bindings" })).toHaveAttribute("href", "/admin/assistant/bindings");
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate-away")).not.toBeInTheDocument();
  });

  it("marks the Overview tab active on the index path", () => {
    h.session.value = { user: { role: "superadmin" } };
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
  });

  it("marks the Overview tab active on the trailing-slash index path", () => {
    h.session.value = { user: { role: "superadmin" } };
    h.pathname = "/admin/assistant/";
    render(<AssistantShell />);
    expect(screen.getByRole("link", { name: "Overview" }).className).toContain("active");
  });

  it("highlights only the matching child tab on a child path", () => {
    h.session.value = { user: { role: "superadmin" } };
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

  it("renders nothing while the session is loading", () => {
    h.session.loading = true;
    const { container } = render(<AssistantShell />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the capability-disabled notice on the Bun flavor (no tab bar)", () => {
    h.session.value = { user: { role: "superadmin" } };
    h.assistantEnabled = false;
    render(<AssistantShell />);
    expect(screen.getByText("The Assistant runs on the Cloudflare Workers deployment")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("outlet")).not.toBeInTheDocument();
  });
});

describe("admin assistant providers tab", () => {
  beforeEach(() => {
    h.providers = [];
    h.mcpServers = [];
    h.managedSecrets = false;
  });

  it("renders both the provider registry and the MCP client registry", () => {
    render(<AssistantProvidersTab />);
    expect(screen.getByRole("heading", { name: "Assistant Providers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MCP Clients" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Jev" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save client" })).toBeInTheDocument();
  });

  it("never shows the removed 'MCP Servers' surface or a stdio option", () => {
    render(<AssistantProvidersTab />);
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    const transport = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(Array.from(transport.options).map((o) => o.value)).toEqual(["http", "sse"]);
  });
});

describe("AssistantBindingsTable", () => {
  beforeEach(() => {
    h.bindings = [
      {
        projectId: "p1", projectName: "Emberfall", projectSlug: "emberfall", providerId: "pr1", providerLabel: "Opencode Go",
        modelId: "m1", modelLabel: "gpt-5.1", fallbackCount: 2, writeToolsCount: 3, memoryCount: 7, hasSearchKey: true,
        reasoningEffort: null, updatedAt: "2026-08-27 12:00:00",
      },
      {
        projectId: "p2", projectName: "Pale Reach", projectSlug: "pale-reach", providerId: null, providerLabel: null,
        modelId: null, modelLabel: null, fallbackCount: 0, writeToolsCount: 0, memoryCount: 0, hasSearchKey: false,
        reasoningEffort: null, updatedAt: null,
      },
    ];
  });

  it("renders one row per project with the configured/unconfigured summary", () => {
    render(<AssistantBindingsTable />);
    expect(screen.getByText("Project bindings")).toBeInTheDocument();
    expect(screen.getByText(/2 projects · 1 configured · 1 not configured/)).toBeInTheDocument();
    expect(screen.getByText("Emberfall")).toBeInTheDocument();
    expect(screen.getByText("Opencode Go")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.1")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
  });

  it("renders the Not configured treatment with a Configure CTA", () => {
    render(<AssistantBindingsTable />);
    expect(screen.getByText("Not configured — no provider, model, or fallback chain set")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });
});

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
      { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "sp1", title: "Task in Sprint 7", description: { type: "doc", content: [] }, priority: "pr1", type: "tp1", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
      { id: "t2", projectId: "p1", columnId: "c1", swimlaneId: "sp2", title: "Task in Sprint 8", description: { type: "doc", content: [] }, priority: "pr1", type: "tp1", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    ],
  };

  let queryClient: QueryClient;
  let wrapper: ReturnType<typeof createQueryWrapper>;

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

  it("?swimlane=sp1 pre-filters the list to that lane", async () => {
    h.search.value = { task: undefined, swimlane: "sp1" };
    render(<TasksPage slug="demo" search={h.search.value!} />, { wrapper });
    expect(await screen.findByText("Task in Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Task in Sprint 8")).not.toBeInTheDocument();
    expect(screen.getByText("Sprint: Sprint 7")).toBeInTheDocument();
    expect(screen.getByLabelText("Swimlane filter")).toHaveValue("sp1");
  });

  it("without the param all lanes render", async () => {
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
