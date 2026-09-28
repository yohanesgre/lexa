// @vitest-environment jsdom
// Workspace → Integrations mounts the MCP Clients registry beside the
// Assistant Providers registry (same components as the admin control panel).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}));

// Workspace settings query hooks resolve to empty, idle results.
vi.mock("../../lib/queries", () => {
  const idle = () => ({ data: [], isLoading: false, isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    useSession: () => ({ data: { user: { role: "superadmin" } } }),
    useWorkspaceMembers: idle,
    useUpdateWorkspaceMember: idle,
    useDeleteWorkspaceMember: idle,
    useWorkspaceInvites: idle,
    useCreateWorkspaceInvite: idle,
    useRevokeWorkspaceInvite: idle,
    useCreateSetPasswordLink: idle,
    useTeams: idle,
    useCreateTeam: idle,
    useDeleteTeam: idle,
    useProjects: idle,
  };
});

vi.mock("./SettingsSections", () => ({
  GithubSyncSection: () => <div data-testid="github-sync" />,
  ApiKeysSection: () => null,
  RateLimitSection: () => null,
}));

vi.mock("./assistant/AgentSkillSettings", () => ({
  AgentsSettingsSection: () => null,
  SkillsSettingsSection: () => null,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useAssistantProviders: () => ({ data: [], isLoading: false }),
  useTestProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchModels: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProvider: () => ({ mutate: vi.fn(), isPending: false }),
  useMcpServers: () => ({ data: [], isLoading: false }),
  useCreateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
  useTestMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { WorkspaceSettings } from "./WorkspaceSettings";

describe("Workspace settings integrations tab", () => {
  it("renders the MCP Clients registry beside Assistant Providers", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSettings />);
    await user.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(screen.getByRole("heading", { name: "Assistant Providers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MCP Clients" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save client" })).toBeInTheDocument();
  });

  it("shows the remote-client empty state and never a local stdio form", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSettings />);
    await user.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(screen.getByText("No MCP clients yet")).toBeInTheDocument();
    expect(screen.queryByText(/An optional secret reference supplies a Bearer token/)).not.toBeInTheDocument();
    const transport = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(Array.from(transport.options).map((o) => o.value)).toEqual(["http", "sse"]);
    expect(screen.queryByText(/stdio/i)).not.toBeInTheDocument();
  });
});
