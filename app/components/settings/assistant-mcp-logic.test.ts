// Pure MCP client form/section helpers: HTTP/SSE-only payloads, secret-ref
// validation, slug derivation, tool-count copy. Wireframe
// admin-assistant-providers.html §MCP Clients.
import { describe, it, expect } from "vitest";
import {
  canSubmitMcpForm,
  endpointOf,
  isValidSecretRef,
  MCP_TRANSPORTS,
  mcpFormPayload,
  mcpFormStateFrom,
  slugifyMcpId,
  toolCountsLabel,
  type McpFormState,
} from "./assistant-mcp-logic";

function form(over: Partial<McpFormState> = {}): McpFormState {
  return { label: "Linear", transportType: "http", url: "", secretRef: "", ...over };
}

describe("MCP transports — HTTP/SSE only", () => {
  it("offers exactly the two remote transports, in order", () => {
    expect(MCP_TRANSPORTS).toEqual([
      { value: "http", label: "http (Streamable HTTP)" },
      { value: "sse", label: "sse (legacy)" },
    ]);
  });

  it("never offers stdio", () => {
    expect(MCP_TRANSPORTS.map((t) => t.value)).not.toContain("stdio");
  });
});

describe("mcpFormPayload — remote URL only", () => {
  it("http/sse carries url and never command or args", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://mcp.linear.example/mcp" }))).toEqual({
      label: "Linear",
      transportType: "http",
      url: "https://mcp.linear.example/mcp",
    });
    expect(mcpFormPayload(form({ transportType: "sse", url: "https://mcp.linear.example/sse" }))).toMatchObject({ transportType: "sse", url: "https://mcp.linear.example/sse" });
  });

  it("requires the remote url and a label", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "" }))).toBeNull();
    expect(mcpFormPayload(form({ label: "  " }))).toBeNull();
  });

  it("rejects a secret ref that is neither env: nor file:", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "plain-token" }))).toBeNull();
  });

  it("accepts env: and file: secret refs and omits an empty one", () => {
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "env:LINEAR_MCP_TOKEN" }))).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "file:/run/secrets/linear" }))).toMatchObject({ secretRef: "file:/run/secrets/linear" });
    expect(mcpFormPayload(form({ transportType: "http", url: "https://x.example/mcp", secretRef: "  " }))).not.toHaveProperty("secretRef");
  });
});

describe("MCP helpers", () => {
  it("validates secret ref formats (shape only — the server owns the env-name allowlist)", () => {
    expect(isValidSecretRef("env:FOO_BAR")).toBe(true);
    expect(isValidSecretRef("file:/abs/path")).toBe(true);
    expect(isValidSecretRef("env:lower")).toBe(false);
    expect(isValidSecretRef("file:relative")).toBe(false);
  });

  it("derives the id slug from the label, mirroring the server", () => {
    expect(slugifyMcpId("Linear")).toBe("linear");
    expect(slugifyMcpId("My MCP Client!")).toBe("my-mcp-client");
    expect(slugifyMcpId("!!!")).toBe("mcp-server");
  });

  it("labels the tool counts from the last successful test", () => {
    expect(toolCountsLabel(undefined)).toBe("Not tested");
    expect(toolCountsLabel({ state: "pending" })).toBe("Not tested");
    expect(toolCountsLabel({ state: "ok", toolCount: 12, readOnlyToolCount: 9 })).toBe("12 total · 9 read-only");
  });

  it("reads the remote endpoint", () => {
    expect(endpointOf({ url: "https://x/mcp" })).toBe("https://x/mcp");
    expect(endpointOf(null)).toBe("");
  });
});

describe("mcpFormStateFrom", () => {
  it("defaults a new form to http, never stdio, and canSubmit tracks validity", () => {
    expect(mcpFormStateFrom(null).transportType).toBe("http");
    expect(canSubmitMcpForm(mcpFormStateFrom(null))).toBe(false);
    expect(canSubmitMcpForm(form({ transportType: "http", url: "https://x/mcp" }))).toBe(true);
  });

  it("prefills the form from a stored client and never leaks the secret reference", () => {
    expect(mcpFormStateFrom({ label: "Linear", transportType: "sse", url: "https://x/sse" })).toEqual({
      label: "Linear",
      transportType: "sse",
      url: "https://x/sse",
      secretRef: "",
    });
  });
});
