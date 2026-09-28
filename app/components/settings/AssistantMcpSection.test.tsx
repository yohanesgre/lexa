// @vitest-environment jsdom
// Wireframe admin-assistant-providers.html §MCP Clients: remote HTTP/SSE
// registry with the accurate empty state ("No MCP clients yet"), a
// two-option transport select defaulting to http, one-line field hints, and
// the test-result states (ok counts / MCP_CONNECT_FAILED).
// No section subtitle, no notice panel, no stdio/command/args controls,
// no MCP_STDIO_UNAVAILABLE.
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

const LINEAR: McpServer = {
  id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", command: null,
  args: [], hasSecret: true, enabled: true, createdAt: "t", updatedAt: "t",
};

function row(name: RegExp): HTMLElement {
  return screen.getByRole("row", { name });
}

beforeEach(() => {
  h.servers = [LINEAR];
  h.isLoading = false;
  h.testResult = null;
  h.created = [];
  h.updated = [];
  h.deleted = [];
});

describe("AssistantMcpSection — literal copy", () => {
  it("names the registry MCP Clients and never MCP Servers", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByRole("heading", { name: "MCP Clients" })).toBeInTheDocument();
    // "MCP server" survives only in protocol-correct phrases ("remote MCP servers");
    // never as a user-facing label.
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
    expect(screen.queryByText("MCP servers")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /MCP server/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save server" })).not.toBeInTheDocument();
  });

  it("carries no section subtitle and no verbose notice copy", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/connect to remote MCP servers over HTTP or SSE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/read-only-annotated tools/)).not.toBeInTheDocument();
    expect(screen.queryByText(/An optional secret reference supplies a Bearer token/)).not.toBeInTheDocument();
    expect(screen.queryByText("Only read-only tools are exposed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Connects Lexa's MCP client to a remote MCP server/)).not.toBeInTheDocument();
  });

  it("has no stdio, command, args, seeded or local-process copy anywhere", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/stdio/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/child process|spawn|same host/i)).not.toBeInTheDocument();
    expect(screen.queryByText("seeded")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Args/)).not.toBeInTheDocument();
  });

  it("labels the table columns Client / Endpoint", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Server" })).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — empty state", () => {
  it("renders the wireframe empty state verbatim", () => {
    h.servers = [];
    render(<AssistantMcpSection />);
    expect(screen.getByText("No MCP clients yet")).toBeInTheDocument();
    expect(screen.getByText("Add a remote MCP client below. No clients are pre-seeded.")).toBeInTheDocument();
  });

  it("shows a table-shaped skeleton while loading", () => {
    h.isLoading = true;
    render(<AssistantMcpSection />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("No MCP clients yet")).not.toBeInTheDocument();
  });
});

describe("AssistantMcpSection — transport form", () => {
  it("offers only the two remote transports and defaults to http", () => {
    render(<AssistantMcpSection />);
    const select = screen.getByLabelText("Transport") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["http", "sse"]);
    expect(select.value).toBe("http");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("keeps the URL field across both transports", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.selectOptions(screen.getByLabelText("Transport"), "sse");
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("keeps one line hints for the URL and secret reference fields", () => {
    render(<AssistantMcpSection />);
    expect(screen.getByText(/http\(s\) only · no userinfo · SSRF-checked against the URL allowlist at save and connect/)).toBeInTheDocument();
    expect(screen.getByText(/Bearer token reference, never stored as a secret value/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("env:NAME or file:/abs/path")).toBeInTheDocument();
  });

  it("drops the verbose secret-reference essay", () => {
    render(<AssistantMcpSection />);
    expect(screen.queryByText(/fails closed at connect with no Authorization header/)).not.toBeInTheDocument();
    expect(screen.queryByText(/read back as/)).not.toBeInTheDocument();
  });

  it("marks a stored secret reference as saved without naming its scheme", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Edit MCP client" }));
    const chip = await screen.findByText(/Saved/, { selector: ".chip" });
    // secret_ref is write-only — the app cannot know whether it is env: or file:.
    expect(chip).toHaveTextContent("Saved · •••");
    expect(chip.textContent).not.toContain("env");
    expect(chip.textContent).not.toContain("file:");
  });

  it("saves a client with label + url and no command/args", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.type(screen.getByLabelText("Label"), "Linear");
    await user.type(screen.getByLabelText("URL"), "https://mcp.linear.example/mcp");
    await user.click(screen.getByRole("button", { name: "Save client" }));
    expect(h.created).toEqual([{ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp" }]);
  });
});

describe("AssistantMcpSection — test results", () => {
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

  it("shows MCP_INVALID_TRANSPORT_CONFIG when a test-endpoint transport check fails", async () => {
    const user = userEvent.setup();
    h.testResult = { ok: false, toolCount: 0, readOnlyToolCount: 0, latencyMs: 0, error: { code: "MCP_INVALID_TRANSPORT_CONFIG", message: "unsupported transport" } };
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Test" }));
    expect(await screen.findByText("MCP_INVALID_TRANSPORT_CONFIG")).toBeInTheDocument();
  });
});

describe("AssistantMcpSection — registry actions", () => {
  it("toggling enabled sends the inverted value", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Linear enabled" }));
    expect(h.updated).toEqual([{ id: "linear", enabled: false }]);
  });

  it("delete opens a confirm dialog and deletes by id", async () => {
    const user = userEvent.setup();
    render(<AssistantMcpSection />);
    await user.click(within(row(/Linear/)).getByRole("button", { name: "Delete MCP client" }));
    expect(screen.getByText("Delete MCP client?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Delete client/ }));
    expect(h.deleted).toEqual(["linear"]);
  });
});
