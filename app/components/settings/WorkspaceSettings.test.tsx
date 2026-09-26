// @vitest-environment jsdom
// Wireframe settings-workspace.html: invite hint points at /set-password, and
// the Teams table carries Members + Projects count columns (Runtimes removed
// with the agent-runtime tier).
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";
import { TeamSelectionProvider } from "../../lib/team-selection";
import type { Project } from "../../../shared/types";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to?: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  };
});

const h = vi.hoisted(() => ({
  state: {
    teams: [] as unknown[],
    members: [] as unknown[],
    projects: [] as unknown[],
    invites: [] as unknown[],
  },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useSession: () => ({ data: { user: { role: "superadmin" }, session: { userId: "u-me" } } }),
    useWorkspaceMembers: () => ({ data: h.state.members, isLoading: false }),
    useWorkspaceInvites: () => ({ data: h.state.invites }),
    useTeams: () => ({ data: h.state.teams, isLoading: false }),
    useProjects: () => ({ data: h.state.projects }),
  };
});

import { WorkspaceSettings } from "./WorkspaceSettings";

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
  h.state.teams = [];
  h.state.members = [];
  h.state.projects = [];
  h.state.invites = [];
});

describe("WorkspaceSettings", () => {
  it("invite hint points at /set-password", () => {
    render(<WorkspaceSettings />, { wrapper: wrapper() });
    expect(screen.getByText(/Accepting opens \/set-password/)).toBeInTheDocument();
  });

  it("Teams table shows Members and Projects counts (no Runtimes column)", async () => {
    const user = userEvent.setup();
    h.state.teams = [{ id: "team-1", name: "Core", slug: "core", createdAt: "2026-07-10T00:00:00Z" }];
    h.state.members = [{
      id: "u-me", name: "Alex", email: "alex@example.com", role: "member",
      createdAt: "2026-01-01T00:00:00Z", lastSeen: null,
      teams: [{ teamId: "team-1", teamName: "Core", role: "owner" }],
    }];
    h.state.projects = [
      { id: "p1", name: "Emberfall", slug: "emberfall", key: "EMB", description: "", repos: [], createdAt: "", updatedAt: "", teamId: "team-1" },
      { id: "p2", name: "Pale Reach", slug: "pale-reach", key: "PR", description: "", repos: [], createdAt: "", updatedAt: "", teamId: "team-1" },
    ] as Array<Project & { teamId: string }>;

    render(<WorkspaceSettings />, { wrapper: wrapper() });
    await user.click(screen.getByRole("tab", { name: "Teams" }));

    expect(screen.getByRole("columnheader", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Runtimes" })).not.toBeInTheDocument();

    const row = screen.getByRole("row", { name: /Core/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("1");
    expect(cells[2]).toHaveTextContent("2");
  });

  it("workspace tabs no longer include a Compute tab", () => {
    render(<WorkspaceSettings />, { wrapper: wrapper() });
    expect(screen.queryByRole("tab", { name: "Compute" })).not.toBeInTheDocument();
  });
});
