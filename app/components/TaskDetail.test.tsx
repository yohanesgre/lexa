// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TaskDetail } from "./TaskDetail";
import type { Task } from "../../shared/types";

// TaskDetail pulls useParams/Link from @tanstack/react-router — the slideover
// renders outside any route tree in tests, so mock the router surface.
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: "demo" }),
  Link: ({ className, children, to }: { className?: string; children?: ReactNode; to: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TASK: Task = {
  id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task One",
  description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello body" }] }] },
  priority: "pr-high", type: "tp-feature",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};

const EVENT = { kind: "event", id: 1, taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "Maria created this task", createdAt: "t" };

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
  // LinksSection / SourcesSection fetch on mount in view mode
  routes.set("GET /api/projects/demo/tasks/t1/links", { data: [] });
  routes.set("GET /api/projects/demo/documents/task/t1/sources", { data: [] });
  routes.set("GET /api/projects/demo/wiki", { data: [] });
  // Activity tab
  routes.set("GET /api/projects/demo/tasks/t1/activity", { data: [EVENT], nextCursor: null });
  routes.set("GET /api/projects/demo/members", { data: [] });
  // ForgePopover (mounted in create mode) fetches agents/skills/runtimes
  routes.set("GET /api/forge/agents", { data: [] });
  routes.set("GET /api/forge/skills", { data: [] });
  routes.set("GET /api/forge/runtimes", { data: [] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderDetail(props: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  const onClose = vi.fn();
  const onDelete = vi.fn(async () => {});
  render(
    <TaskDetail
      task={TASK}
      project={{ name: "Demo" }}
      columns={[{ id: "c1", name: "Todo" }]}
      swimlanes={[{ id: "s1", name: "Backlog" }]}
      fieldConfig={{
        priorities: [{ id: "pr-high", label: "High", color: "#FF4444" }],
        types: [{ id: "tp-feature", label: "Feature", color: "#4ADE80" }],
      }}
      onClose={onClose}
      onUpdate={vi.fn()}
      onMove={vi.fn()}
      onDelete={onDelete}
      onArchive={vi.fn()}
      onRestore={vi.fn()}
      onLinkGithub={vi.fn()}
      onUnlinkGithub={vi.fn()}
      onCreate={vi.fn()}
      {...props}
    />,
    { wrapper }
  );
  return { onClose, onDelete };
}

describe("TaskDetail (view mode)", () => {
  it("renders title, property bar, tabs, and the description body", async () => {
    renderDetail();
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("hello body")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Feature")).toBeInTheDocument();
  });

  it("shows the missing-fields warning for the task's column", async () => {
    renderDetail({
      columnRequiredFields: [{ columnId: "c1", fields: ["description", "assignee"] }],
    });
    // the task HAS a description ("hello body") — only assignee is missing
    expect(await screen.findByText("Todo requires assignee")).toBeInTheDocument();
  });

  it("Activity tab fetches and renders the timeline", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(await screen.findByText("Maria created this task")).toBeInTheDocument();
    // exactly one activity fetch — no refetch on tab switches
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/activity"))).toHaveLength(1);
  });

  it("delete flow: footer Delete opens the dialog and confirms", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderDetail();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete task")).toBeInTheDocument();
    // two "Delete" buttons exist once the dialog is open (footer + dialog)
    const dialog = screen.getByText("Delete task").closest("dialog")!;
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("t1"));
  });
});

describe("TaskDetail (create mode — TipTap smoke)", () => {
  it("mounts the TipTap description editor without crashing", async () => {
    renderDetail({ mode: "create", task: undefined });
    expect(screen.getByLabelText("Task title")).toBeInTheDocument();
    expect(screen.getByText("Create task")).toBeInTheDocument();
    // The TipTap editor mounted: the ProseMirror node exists and the toolbar
    // (which requires a live editor instance) renders its command buttons.
    // jsdom renders the ProseMirror div without children — mount is what matters.
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading 2" })).toBeInTheDocument();
  });
});
