// @vitest-environment jsdom
// Wireframe settings-project-herald.html §MCP clients: per-project availability
// default OFF; the empty state is the "No MCP clients registered" box with the
// workspace link; globally-disabled clients render a disabled toggle with
// "Global off"; toggling PUTs the replace-set.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  servers: [] as unknown[],
  managedSecrets: true as boolean | undefined,
  rows: [] as unknown[],
  saved: [] as unknown[],
  pending: false,
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useMcpServers: () => ({ data: h.servers, isLoading: false }),
  useMcpManagedSecrets: () => ({ data: h.managedSecrets }),
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
  args: [], hasSecret: false, secretSource: "none", enabled: true, createdAt: "t", updatedAt: "t",
};
const NOTION: McpServer = {
  id: "notion", label: "Notion", transportType: "sse", url: "https://mcp.notion.example/sse", command: null,
  args: [], hasSecret: false, secretSource: "none", enabled: false, createdAt: "t", updatedAt: "t",
};

beforeEach(() => {
  h.servers = [NOTION, LINEAR];
  h.managedSecrets = true;
  h.rows = [];
  h.saved = [];
  h.pending = false;
});

describe("AssistantProjectMcpSection", () => {
  it("names the section MCP clients and never MCP servers", () => {
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByRole("heading", { name: "MCP clients" })).toBeInTheDocument();
    expect(screen.queryByText("MCP servers")).not.toBeInTheDocument();
    expect(screen.queryByText(/stdio/i)).not.toBeInTheDocument();
  });

  it("keeps the read-only tools and default-off markers", () => {
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByText("read-only tools")).toBeInTheDocument();
    expect(screen.getByText("default off")).toBeInTheDocument();
  });

  it("labels the table columns Client / Endpoint", () => {
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Server" })).not.toBeInTheDocument();
  });

  it("defaults to off and disables globally-off clients with 'Global off'", () => {
    render(<AssistantProjectMcpSection project={PROJECT} />);
    const notionRow = screen.getByRole("row", { name: /Notion/ });
    expect(within(notionRow).getByRole("button", { name: "Notion not enabled for this project" })).toBeDisabled();
    expect(within(notionRow).getByText("Global off")).toBeInTheDocument();

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
      { serverId: "notion", enabled: false },
      { serverId: "linear", enabled: true },
    ]]);
  });

  it("empty registry renders the wireframe empty box linking to workspace", () => {
    h.servers = [];
    render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.getByText("No MCP clients registered")).toBeInTheDocument();
    expect(screen.getByText("Register a remote MCP client in Workspace settings before enabling it for this project.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Workspace → Assistant Providers/ })).toHaveAttribute("href", "/settings/workspace");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("carries no verbose helper paragraph under the table", () => {
    const { container } = render(<AssistantProjectMcpSection project={PROJECT} />);
    expect(screen.queryByText(/Which registered Remote MCP clients/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A client must be enabled globally first/)).not.toBeInTheDocument();
    expect(container.querySelectorAll(".field-hint")).toHaveLength(0);
  });
});
