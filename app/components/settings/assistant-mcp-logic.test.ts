// Pure MCP client form/section helpers: HTTP/SSE-only payloads, one write-only
// managed token, the clearSecret-only removal route, slug derivation,
// tool-count copy. Wireframe admin-assistant-providers.html §MCP Clients
// (one credential field + no-master-key states).
import { describe, it, expect } from "vitest";
import {
  canSubmitMcpForm,
  endpointOf,
  MCP_TRANSPORTS,
  mcpFormPayload,
  mcpFormStateFrom,
  requestClearSecret,
  slugifyMcpId,
  toolCountsLabel,
  withSecretField,
  type McpFormState,
} from "./assistant-mcp-logic";

function form(over: Partial<McpFormState> = {}): McpFormState {
  return {
    label: "Linear",
    transportType: "http",
    url: "https://mcp.linear.example/mcp",
    secret: "",
    clearPending: false,
    ...over,
  };
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
});

describe("mcpFormPayload — one write-only managed token", () => {
  it("carries a non-empty token verbatim as `secret`", () => {
    expect(mcpFormPayload(form({ secret: "lin_api_3f9c1d7b2e" }))).toEqual({
      label: "Linear",
      transportType: "http",
      url: "https://mcp.linear.example/mcp",
      secret: "lin_api_3f9c1d7b2e",
    });
  });

  it("trims surrounding whitespace before deciding the token is non-empty", () => {
    expect(mcpFormPayload(form({ secret: "  tok  " }))).toMatchObject({ secret: "tok" });
  });

  it("omits a blank token — a secret-less client is legal", () => {
    const payload = mcpFormPayload(form({ secret: "   " }));
    expect(payload).toEqual({ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp" });
    expect(payload).not.toHaveProperty("secret");
    expect(canSubmitMcpForm(form({ secret: "" }))).toBe(true);
  });

  it("never emits a secretRef — the field is gone", () => {
    const payload = mcpFormPayload(form({ secret: "tok" }));
    expect(payload).not.toHaveProperty("secretRef");
  });
});

describe("mcpFormPayload — removal only via clearSecret", () => {
  it("a blank token is never sent expecting a clear (empty means keep)", () => {
    const payload = mcpFormPayload(form({ secret: "   " }));
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("clearSecret");
  });

  it("a pending clear sends clearSecret: true and no token at all", () => {
    const payload = mcpFormPayload(requestClearSecret(form({ secret: "tok" })));
    expect(payload).toEqual({ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", clearSecret: true });
    expect(payload).not.toHaveProperty("secret");
  });
});

describe("withSecretField / requestClearSecret", () => {
  it("typing into the field cancels a pending clear — the secret is kept", () => {
    const pending = requestClearSecret(form());
    const typed = withSecretField(pending, "tok");
    expect(typed.clearPending).toBe(false);
    expect(typed.secret).toBe("tok");
    expect(mcpFormPayload(typed)).not.toHaveProperty("clearSecret");
  });

  it("a confirmed clear empties the field and raises the flag", () => {
    const state = requestClearSecret(form({ secret: "tok" }));
    expect(state).toMatchObject({ clearPending: true, secret: "" });
  });
});

describe("MCP helpers", () => {
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

  it("prefills label/transport/url and never leaks a secret value", () => {
    expect(mcpFormStateFrom({ label: "Linear", transportType: "sse", url: "https://x/sse" })).toEqual({
      label: "Linear",
      transportType: "sse",
      url: "https://x/sse",
      secret: "",
      clearPending: false,
    });
    expect(mcpFormStateFrom({ label: "Linear", transportType: "http", url: "https://x/mcp" }).secret).toBe("");
  });

  it("carries no secret-mode or secret-ref state at all", () => {
    const state = mcpFormStateFrom(null);
    expect(state).not.toHaveProperty("secretMode");
    expect(state).not.toHaveProperty("secretRef");
  });
});
