// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";

const h = vi.hoisted(() => ({
  sessionUser: null as null | { role: "superadmin" | "member" },
  createInput: undefined as undefined | { name: string; description?: string | undefined; teamId: string | null },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({ ...config, useParams: () => ({ slug: "demo" }) }),
  Link: ({ to, className, children }: { to: string; className?: string; children?: React.ReactNode }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/queries", () => {
  const project = { id: "p1", slug: "demo", name: "Nimbus", description: "", repos: [], createdAt: "t", updatedAt: "t" };
  const board = {
    project,
    columns: [],
    swimlanes: [],
    milestones: [],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [],
  };
  const health = {
    project,
    taskCount: 0,
    columnCount: 0,
    urgentCount: 0,
    syncCount: 0,
    health: "ok",
    wipSegments: [],
  };
  const dashboard = { projects: [], urgentTasks: [], outOfSyncTasks: [], activity: [] };
  return {
    useDashboard: () => ({ data: dashboard, isLoading: false }),
    useBoard: () => ({ data: board, isError: false, error: null }),
    useMilestones: () => ({ data: [] }),
    useCreateProject: () => ({
      isPending: false,
      mutate: (input: { name: string; description?: string | undefined; teamId: string | null }, opts?: { onSuccess?: () => void }) => {
        h.createInput = input;
        opts?.onSuccess?.();
      },
    }),
    useTeams: () => ({ data: [], isLoading: false }),
    useSession: () => ({ data: { session: null, user: h.sessionUser } }),
    selectProjectHealth: () => health,
  };
});

vi.mock("../../components/DashboardSkeleton", () => ({ DashboardSkeleton: () => null }));
vi.mock("../../components/ProjectDescription", () => ({ ProjectDescription: () => null }));
vi.mock("../../components/milestones/MilestoneCard", () => ({ MilestoneCard: () => null }));

import { Route } from "./index";

describe("project dashboard header", () => {
  beforeEach(() => {
    h.sessionUser = null;
    h.createInput = undefined;
  });

  it("New Project button opens CreateProjectModal", async () => {
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));

    expect(screen.getByText("Create Project")).toBeInTheDocument();
  });

  it("a superadmin can submit an unassigned project without picking a team", async () => {
    h.sessionUser = { role: "superadmin" };
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Name"), "Unassigned");

    const submit = screen.getByRole("button", { name: /create project/i });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(h.createInput).toEqual({ name: "Unassigned", description: undefined, teamId: null });
  });

  it("a superadmin sees the Global (no team) option and it submits teamId:null", async () => {
    h.sessionUser = { role: "superadmin" };
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Name"), "Global");
    await user.selectOptions(screen.getByLabelText("Project team"), "global");
    await user.click(screen.getByRole("button", { name: /create project/i }));
    expect(h.createInput).toEqual({ name: "Global", description: undefined, teamId: null });
  });

  it("a member does not see the Global (no team) option", async () => {
    h.sessionUser = { role: "member" };
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.queryByRole("option", { name: "Global (no team)" })).not.toBeInTheDocument();
  });

  it("a member cannot submit without a team", async () => {
    h.sessionUser = { role: "member" };
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Name"), "Needs a team");

    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();
  });
});
