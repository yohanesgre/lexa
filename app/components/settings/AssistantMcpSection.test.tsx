// @vitest-environment jsdom
// Wireframe admin-assistant-providers.html §MCP Servers: seeded Jev rendered
// disabled with the same-host stdio caveat, transport-conditional form fields,
// and the test-result states (ok counts / MCP_CONNECT_FAILED /
// MCP_STDIO_UNAVAILABLE via body error.code).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  servers: [] as unknown[],
  isLoading: false,
  testResult: null as unknown,
  created: [] as unknown[],
  updated: [] as unknown[],
  deleted: [] as unknown[],
}));

vi.mock("../../lib/queries/assistant-admin", () => ({
  useMcpServers: () => ({ data: h.servers, isLoading: h.isLoading }),
  useCreateMcpServer: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.created.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useUpdateMcpServer: () => ({ mutate: (input: unknown, opts?: { onSuccess?: () => void }) => { h.updated.push(input); opts?.onSuccess?.(); }, isPending: false }),
  useDeleteMcpServer: () => ({ mutate: (id: string, opts?: { onSuccess?: () => void }) => { h.deleted.push(id); opts?.onSuccess?.(); }, isPending: false }),
  useTestMcpServer: () => ({ mutate: (_id: string, opts?: { onSuccess?: (res: unknown) => void }) => { opts?.onSuccess?.(h.testResult); }, isPending: false }),
}));

import { AssistantMcpSection } from "./AssistantMcpSection";
import type { McpServer } from "../../lib/api";

const JEV: McpServer = {
  id: "jev", label: "Jev", transportType: "stdio", url: null, command: "jev-mcp",
  args: [], hasSecret: false, enabled: false, createdAt: "t", updatedAt: "t",
};
const LINEAR: McpServer = {
  id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", command: null,
  args: [], hasSecret: true, enabled: true, createdAt: "t", updatedAt: "t",
};

function row(name: RegExp): HTMLElement {
  return screen.getByRole("row", { name });
}

beforeEach(() => {
  h.servers = [JEV, LINEAR];
  h.isLoading = false;
  h.testResult = null;
  h.created = [];
  h.updated = [];
  h.deleted = [];
});

describe("AssistantMcpSection", () => {
  it("renders the seeded Jev row disabled with the same-host stdio caveat", () => {
    render(<AssistantMcpSection />);
    const jevRow = row(/Jev/);
    expect(within(jevRow).getByText("jev")).toBeInTheDocument();
    expect(within(jevRow).getByText("seeded")).toBeInTheDocument();
    expect(within(jevRow).getByText("stdio")).toBeInTheDocument();
    expect(within(jevRow).getByText("jev-mcp")).toBeInTheDocument();
    expect(within(jevRow).getByText("Not tested")).toBeInTheDocument();
    expect(within(jevRow).getByRole("button", { name: "Jev disabled" })).not.toHaveClass("is-on");
    // The stdio form (default transport) carries the caveat copy.
    expect(screen.getByText(/stdio runs only when the Lexa server runs on this host/)).toBeInTheDocument();
  });

  it("swaps the endpoint fields when the transport changes", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    expect(screen.getByLabelText("Command")).toBeInTheDocument();
    expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Transport"), "http");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Transport"), "sse");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("shows OK tool counts in the row from the test response body", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: true, toolCount: 12, readOnlyToolCount: 9, latencyMs: 412, error: null };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("12 total · 9 read-only")).toBeInTheDocument();
  });

  it("shows MCP_CONNECT_FAILED from a failed test body (HTTP 200)", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: false, toolCount: 0, readOnlyToolCount: 0, latencyMs: 0, error: { code: "MCP_CONNECT_FAILED", message: "handshake failed" } };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("MCP_CONNECT_FAILED")).toBeInTheDocument();
  });

  it("shows MCP_STDIO_UNAVAILABLE from the stdio test body", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: false, toolCount: 0, readOnlyToolCount: 0, latencyMs: 0, error: { code: "MCP_STDIO_UNAVAILABLE", message: "stdio unavailable" } };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Jev/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("MCP_STDIO_UNAVAILABLE")).toBeInTheDocument();
  });

  it("toggling enabled sends the inverted value", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Jev/)).getByRole("button", { name: "Jev disabled" }));
    expect(h.updated).toEqual([{ id: "jev", enabled: true }]);
  });

  it("delete opens a confirm dialog and deletes by id", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Delete MCP server" }));
    expect(screen.getByText("Delete MCP server?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Delete server/ }));
    expect(h.deleted).toEqual(["linear"]);
  });
});
