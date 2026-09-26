// Pure MCP form/section helpers: transport-conditional payloads, args JSON
// parsing, secret-ref validation, slug derivation, tool-count copy.
import { describe, it, expect } from "vitest";
import {
  canSubmitMcpForm,
  endpointOf,
  isSeededMcpServer,
  isValidSecretRef,
  mcpFormPayload,
  mcpFormStateFrom,
  parseArgs,
  slugifyMcpId,
  toolCountsLabel,
  type McpFormState,
} from "./assistant-mcp-logic";

function form(over: Partial<McpFormState> = {}): McpFormState {
  return { label: "Linear", transportType: "http", url: "", command: "", args: "", secretRef: "", ...over };
}

describe("mcpFormPayload — transport-conditional fields", () => {
  it("http/sse carries url and never command", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://mcp.linear.example/mcp" }))).toEqual({
      label: "Linear",
      transportType: "http",
      url: "https://mcp.linear.example/mcp",
      args: [],
    });
    expect(mcpFormPayload(form({ transportType: "sse", url: "https://mcp.linear.example/sse" }))).toMatchObject({ transportType: "sse", url: "https://mcp.linear.example/sse" });
  });

  it("stdio carries command and never url", () => {
    const payload = mcpFormPayload(form({ label: "Jev", transportType: "stdio", command: "jev-mcp", args: '["--profile","work"]' }));
    expect(payload).toEqual({ label: "Jev", transportType: "stdio", command: "jev-mcp", args: ["--profile", "work"] });
    expect(payload).not.toHaveProperty("url");
  });

  it("requires the transport-specific endpoint", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "" }))).toBeNull();
    expect(mcpFormPayload(form({ transportType: "stdio", command: "" }))).toBeNull();
    expect(mcpFormPayload(form({ label: "  " }))).toBeNull();
  });

  it("rejects invalid args JSON and invalid secret refs", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", args: "not-json" }))).toBeNull();
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", args: '["a", 2]' }))).toBeNull();
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "plain-token" }))).toBeNull();
  });

  it("accepts env: and file: secret refs and omits an empty one", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "env:LINEAR_MCP_TOKEN" }))).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "file:/run/secrets/linear" }))).toMatchObject({ secretRef: "file:/run/secrets/linear" });
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "  " }))).not.toHaveProperty("secretRef");
  });
});

describe("MCP helpers", () => {
  it("parses args, empty means none", () => {
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs('["--stdio"]')).toEqual(["--stdio"]);
    expect(parseArgs("[1]")).toBeNull();
  });

  it("validates secret ref formats", () => {
    expect(isValidSecretRef("env:FOO_BAR")).toBe(true);
    expect(isValidSecretRef("file:/abs/path")).toBe(true);
    expect(isValidSecretRef("env:lower")).toBe(false);
    expect(isValidSecretRef("file:relative")).toBe(false);
  });

  it("derives the id slug from the label, mirroring the server", () => {
    expect(slugifyMcpId("Linear")).toBe("linear");
    expect(slugifyMcpId("My MCP Server!")).toBe("my-mcp-server");
    expect(slugifyMcpId("!!!")).toBe("mcp-server");
  });

  it("labels the tool counts from the last successful test", () => {
    expect(toolCountsLabel(undefined)).toBe("Not tested");
    expect(toolCountsLabel({ state: "pending" })).toBe("Not tested");
    expect(toolCountsLabel({ state: "ok", toolCount: 12, readOnlyToolCount: 9 })).toBe("12 total · 9 read-only");
  });

  it("reads the endpoint per transport and flags the seeded preset", () => {
    expect(endpointOf({ transportType: "stdio", url: null, command: "jev-mcp" })).toBe("jev-mcp");
    expect(endpointOf({ transportType: "http", url: "https://x/mcp", command: null })).toBe("https://x/mcp");
    expect(isSeededMcpServer({ id: "jev" })).toBe(true);
    expect(isSeededMcpServer({ id: "linear" })).toBe(false);
  });

  it("defaults a new form to stdio and canSubmit tracks validity", () => {
    expect(mcpFormStateFrom(null).transportType).toBe("stdio");
    expect(canSubmitMcpForm(mcpFormStateFrom(null))).toBe(false);
    expect(canSubmitMcpForm(form({ transportType: "http", url: "https://x/mcp" }))).toBe(true);
  });
});
