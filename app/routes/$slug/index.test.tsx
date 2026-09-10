// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";

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
    useCreateProject: () => ({ isPending: false, mutate: vi.fn() }),
    useTeams: () => ({ data: [], isLoading: false }),
    selectProjectHealth: () => health,
  };
});

vi.mock("../../components/DashboardSkeleton", () => ({ DashboardSkeleton: () => null }));
vi.mock("../../components/ProjectDescription", () => ({ ProjectDescription: () => null }));
vi.mock("../../components/milestones/MilestoneCard", () => ({ MilestoneCard: () => null }));

import { Route } from "./index";

describe("project dashboard header", () => {
  it("New Project button opens CreateProjectModal", async () => {
    const user = userEvent.setup();
    const Component = (Route as unknown as { component: ComponentType }).component;
    render(<Component />);

    await user.click(screen.getByRole("button", { name: /new project/i }));

    expect(screen.getByText("Create Project")).toBeInTheDocument();
  });
});
