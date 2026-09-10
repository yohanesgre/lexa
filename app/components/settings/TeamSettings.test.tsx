// @vitest-environment jsdom
// Wireframe settings-team.html: Projects table carries Health + Tasks columns;
// the add-member row is a single email input + type-ahead (no inline role
// select, no Add button).
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";
import { TeamSelectionProvider } from "../../lib/team-selection";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  };
});

const h = vi.hoisted(() => ({
  state: { dashboard: undefined as unknown },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: { user: { role: "member" }, session: { userId: "u-me" } } }),
    useTeams: () => ({ data: [{ id: "team-1", name: "Core", slug: "core", createdAt: "2026-01-01T00:00:00Z" }], isLoading: false }),
    useTeamMembers: () => ({ data: [], isLoading: false }),
    useWorkspaceMembers: () => ({ data: [] }),
    useTeamRuntimes: () => ({ data: [], isLoading: false, isError: false }),
    useDashboard: () => ({ data: h.state.dashboard }),
  };
});

import { TeamSettings } from "./TeamSettings";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <TeamSelectionProvider>
        <ToastProvider>{children}</ToastProvider>
      </TeamSelectionProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  h.state.dashboard = undefined;
});

describe("TeamSettings", () => {
  it("Projects table shows Health and Tasks columns", () => {
    h.state.dashboard = {
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
