// @vitest-environment jsdom
// Wireframe settings-project-herald.html §MCP servers: per-project availability
// default OFF; globally-disabled servers render a disabled toggle with
// "Global off"; toggling PUTs the replace-set.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  servers: [] as unknown[],
  rows: [] as unknown[],
  saved: [] as unknown[],
  pending: false,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useMcpServers: () => ({ data: h.servers, isLoading: false }),
  useProjectMcpServers: () => ({ data: h.rows }),
  useSetProjectMcpServers: () => ({ mutate: (entries: unknown, opts?: { onSuccess?: () => void }) => { h.saved.push(entries); opts?.onSuccess?.(); }, isPending: h.pending }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { AssistantProjectMcpSection } from "./AssistantProjectMcpSection";
import type { McpServer } from "../../lib/api";
import type { Project } from "../../../shared/types";

const PROJECT = { id: "p1", name: "Emberfall", slug: "emberfall" } as unknown as Project;

const LINEAR: McpServer = {
  id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", command: null,
  args: [], hasSecret: false, enabled: true, createdAt: "t", updatedAt: "t",
};
const JEV: McpServer = {
  id: "jev", label: "Jev", transportType: "stdio", url: null, command: "jev-mcp",
  args: [], hasSecret: false, enabled: false, createdAt: "t", updatedAt: "t",
};

beforeEach(() => {
  h.servers = [JEV, LINEAR];
  h.rows = [];
  h.saved = [];
  h.pending = false;
});

describe("AssistantProjectMcpSection", () => {
  it("defaults to off and disables globally-off servers with 'Global off'", () => {
    render(<AssistantProjectMcpSection project={PROJECT} />);
    const jevRow = screen.getByRole("row", { name: /Jev/ });
    expect(within(jevRow).getByRole("button", { name: "Jev not enabled for this project" })).toBeDisabled();
    expect(within(jevRow).getByText("Global off")).toBeInTheDocument();

    const linearRow = screen.getByRole("row", { name: /Linear/ });
    expect(within(linearRow).getByRole("button", { name: "Linear not enabled for this project" })).not.toHaveClass("is-on");
  });

  it("reflects a stored project row as enabled", () => {
    h.rows = [{ projectId: "p1", serverId: "linear", enabled: true, createdAt: "t", updatedAt: "t" }];
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByRole("button", { name: "Linear enabled for this project" })).toHaveClass("is-on");
  });

  it("toggling sends the full replace-set with the flipped value", async () => {
    const user = userEvent.setup();
    render(<AssistantProjectMcpSection project={PROJECT} />);
    await user.click(screen.getByRole("button", { name: "Linear not enabled for this project" }));
    expect(h.saved).toEqual([[
      { serverId: "jev", enabled: false },
      { serverId: "linear", enabled: true },
    ]]);
  });

  it("empty registry shows the muted one-liner linking to workspace", () => {
    h.servers = [];
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByText(/No MCP servers registered/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Workspace → Assistant Providers/ })).toHaveAttribute("href", "/settings/workspace");
  });
});
