// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, GithubIssue, Milestone, WikiPageMeta } from "../../shared/types";
import {
  createQueryWrapper,
  createTestQueryClient,
  json,
  makeBoard as makeBoardFixture,
  ResizeObserverStub,
} from "../test-utils";

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/emberfall/sprnt-7" } }),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    className,
    children,
  }: {
    to: string;
    params?: Record<string, string> | undefined;
    className?: string | undefined;
    children: ReactNode;
  }) => (
    <a href={to} data-params={params ? JSON.stringify(params) : undefined} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queries")>();
  return {
    ...actual,
    useBoard: () => ({ data: undefined }),
    useUpdateSwimlane: () => ({ mutate: vi.fn() }),
    useUpdateMilestone: () => ({ mutate: vi.fn() }),
    useDeleteMilestone: () => ({ mutate: vi.fn() }),
    useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  };
});

import { GitHubSection } from "./GitHubSection";
import { PageNotFound } from "./PageNotFound";
import { WikiPageNotFound } from "./wiki/WikiPageNotFound";
import { TimelineTab } from "./milestones/TimelineTab";
import { Field } from "./ui/Field";
import { WarningNotice } from "./ui/NoticeWarning";
import { ConfirmDialog } from "./ui/ConfirmDialog";

describe("GitHubSection", () => {
  const fetchMock = vi.fn();
  let queryClient: QueryClient;
  let wrapper: ReturnType<typeof createQueryWrapper>;

  const ISSUE: GithubIssue = {
    issueId: "ghi1",
    issueNumber: 107,
    repo: "emberfall-godot",
    title: "Crash on large board load",
    syncedState: "open",
    url: "https://github.com/emberfall-godot/issues/107",
    outOfSync: false,
    pushFailed: false,
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
    queryClient = createTestQueryClient();
    wrapper = createQueryWrapper(queryClient, { toast: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  function renderSection(githubs: GithubIssue[]) {
    return render(
      <GitHubSection
        taskId="t1"
        slug="demo"
        githubs={githubs}
        columnGithubState="open"
        onLink={async () => null}
        onUnlink={async () => {}}
      />,
      { wrapper }
    );
  }

  it("renders repo #number · title when the title is present", () => {
    renderSection([ISSUE]);
    expect(screen.getByText("emberfall-godot #107")).toBeInTheDocument();
    expect(screen.getByText("· Crash on large board load")).toBeInTheDocument();
  });

  it("renders only repo #number when the title is null", () => {
    renderSection([{ ...ISSUE, title: null }]);
    expect(screen.getByText("emberfall-godot #107")).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });
});

describe("PageNotFound", () => {
  it("shows the heading and always links back to the dashboard", () => {
    render(<PageNotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Dashboard/ })).toHaveAttribute("href", "/");
  });

  it("prints the attempted pathname", () => {
    render(<PageNotFound />);
    expect(screen.getByText(/GET \/emberfall\/sprnt-7 → NO MATCH/)).toBeInTheDocument();
  });
});

describe("WikiPageNotFound", () => {
  it("shows the heading and the attempted slug", () => {
    render(<WikiPageNotFound slug="emberfall" pageSlug="missing-page" />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("/wiki/missing-page")).toBeInTheDocument();
  });

  it("links to the first loaded page and hides the action when there are none", () => {
    const pages: WikiPageMeta[] = [
      {
        id: "p2",
        projectId: "pr1",
        title: "Second",
        slug: "second",
        parentId: null,
        position: 1,
        updatedBy: null,
        updatedByName: null,
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
      {
        id: "p1",
        projectId: "pr1",
        title: "Home",
        slug: "home",
        parentId: null,
        position: 0,
        updatedBy: null,
        updatedByName: null,
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
    ];
    const { rerender } = render(<WikiPageNotFound slug="emberfall" pageSlug="missing-page" pages={pages} />);
    const first = screen.getByRole("link", { name: "Go to first page" });
    expect(first).toHaveAttribute("data-params", JSON.stringify({ slug: "emberfall", pageSlug: "home" }));

    rerender(<WikiPageNotFound slug="emberfall" pageSlug="missing-page" pages={[]} />);
    expect(screen.queryByRole("link", { name: "Go to first page" })).toBeNull();
  });
});

describe("TimelineTab", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ResizeObserverStub.instances = [];
  });

  const MILESTONE: Milestone = {
    id: "m1",
    projectId: "p1",
    name: "v1.0 launch",
    description: "",
    position: 0,
    dueAt: "2026-06-01",
    archivedAt: null,
    sprintCount: 1,
    archivedSprintCount: 0,
    tasksDone: 0,
    tasksTotal: 0,
  };

  function makeBoard(): Board {
    return makeBoardFixture({
      swimlanes: [
        { id: "s1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, startAt: null, archivedAt: null, kind: "sprint", milestoneId: "m1", tasksDone: 0, tasksTotal: 0 },
        { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 1, dueAt: null, startAt: null, archivedAt: null, kind: "backlog", milestoneId: null, tasksDone: 0, tasksTotal: 0 },
        { id: "s10", projectId: "p1", name: "Old lane", description: "", position: 2, dueAt: null, startAt: null, archivedAt: "2026-01-01", kind: "sprint", milestoneId: null, tasksDone: 0, tasksTotal: 0 },
      ],
      milestones: [MILESTONE],
    });
  }

  const wrapper = createQueryWrapper(createTestQueryClient());

  it("renders the Backlog caption row for a backlog lane", () => {
    const { container } = render(
      <TimelineTab slug="demo" board={makeBoard()} milestones={[MILESTONE]} />,
      { wrapper }
    );

    expect(screen.getByText("system lane")).toBeInTheDocument();
    const captions = container.querySelectorAll(".tl-label.caption");
    expect(captions).toHaveLength(1);
    expect(captions[0]).toHaveTextContent("Backlog");
  });
});

describe("ui (ui-gaps-w3)", () => {
  it("maps Field errors, WarningNotice, and ConfirmDialog variants to the documented primitives", () => {
    const field = render(
      <Field label="Email" error="Invalid email">
        <input />
      </Field>
    );
    const notice = field.container.querySelector(".notice.notice-danger");
    expect(notice).not.toBeNull();
    expect(notice).toHaveTextContent("Invalid email");
    expect(field.container.querySelector(".field-hint-danger")).toBeNull();
    field.unmount();

    const warning = render(<WarningNotice title="No providers yet">Configure one</WarningNotice>);
    expect(warning.container.querySelector(".card-panel.card-panel--warning")).not.toBeNull();
    warning.unmount();

    const danger = render(
      <ConfirmDialog title="Delete?" body="Gone" confirmLabel="Delete" onCancel={vi.fn()} onConfirm={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("btn", "btn-ghost", "btn-sm");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("btn", "btn-danger-solid", "btn-sm");
    danger.unmount();

    render(
      <ConfirmDialog variant="default" title="Promote?" body="Sure" confirmLabel="Promote" onCancel={vi.fn()} onConfirm={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Promote" })).toHaveClass("btn", "btn-primary", "btn-sm");
  });
});
