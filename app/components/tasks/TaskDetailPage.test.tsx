// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TaskDetailPage } from "./TaskDetailPage";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => navigateMock,
  useParams: () => ({ slug: "demo" }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TASK = {
  id: "t1",
  key: "EG-18",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "sp1",
  title: "Crash on large board load",
  description: { type: "doc", content: [] },
  priority: "pr1",
  type: "tp1",
  assignees: [],
  position: "a0",
  githubs: [],
  dueAt: null,
  archivedAt: null,
  createdAt: "t",
  updatedAt: "t",
};

const BOARD = {
  project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [
    { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
  ],
  swimlanes: [
    { id: "sp1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
  ],
  milestones: [],
  fieldConfig: {
    priorities: [{ id: "pr1", label: "High", color: "#FF4444", position: 0 }],
    types: [{ id: "tp1", label: "Task", color: "#4ADE80", position: 0 }],
  },
  links: [],
  tasks: [TASK],
};

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function defaultFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/board")) return Promise.resolve(json(BOARD));
    if (/\/tasks\/t1$/.test(url)) return Promise.resolve(json(TASK));
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  defaultFetch();
  navigateMock.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("TaskDetailPage", () => {
  it("renders the task detail inside the page-frame-narrow shell", async () => {
    render(<TaskDetailPage slug="demo" taskId="t1" from="tasks" />, { wrapper });
    expect(await screen.findByText("Crash on large board load")).toBeInTheDocument();

    const main = document.querySelector("main.page-frame.page-frame-narrow");
    expect(main).not.toBeNull();
    expect(main!.querySelector(".task-page")).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("shows the not-found state for a stale deep link", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/board")) return Promise.resolve(json(BOARD));
      if (/\/tasks\/missing$/.test(url)) return Promise.resolve(json({ error: { code: "TASK_NOT_FOUND", message: "Task not found" } }, 404));
      return Promise.resolve(json({ data: [] }));
    });
    render(<TaskDetailPage slug="demo" taskId="missing" from={undefined} />, { wrapper });
    expect(await screen.findByText("Task not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Tasks" })).toBeInTheDocument();
  });

  it("reflects edits when the URL addresses the task by ticket key", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PATCH" && /\/tasks\/t1$/.test(url)) {
        return Promise.resolve(json({ data: { ...TASK, title: "Edited via key URL" }, activity: [] }));
      }
      if (url.includes("/board")) return Promise.resolve(json(BOARD));
      if (/\/tasks\/P1-1$/.test(url)) return Promise.resolve(json(TASK));
      if (/\/tasks\/t1$/.test(url)) return Promise.resolve(json(TASK));
      return Promise.resolve(json({ data: [] }));
    });
    render(<TaskDetailPage slug="demo" taskId="P1-1" from="tasks" />, { wrapper });
    expect(await screen.findByText("Crash on large board load")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Click to edit"));
    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "Edited via key URL" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Edited via key URL")).toBeInTheDocument();
  });

  it("uses the wiki-style description editor with no chrome band", async () => {
    render(<TaskDetailPage slug="demo" taskId="t1" from="tasks" />, { wrapper });
    expect(await screen.findByText("Crash on large board load")).toBeInTheDocument();

    const prose = document.querySelector(".td-prose");
    expect(prose).not.toBeNull();
    fireEvent.doubleClick(prose!);

    expect(await screen.findByText("Editing description")).toBeInTheDocument();
    const editorWrapper = document.querySelector(".editor-wrapper");
    expect(editorWrapper).not.toBeNull();
    expect(editorWrapper!.querySelector(".editor-toolbar")).not.toBeNull();
  });
});
