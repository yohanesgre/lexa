// Pure MCP client form/section helpers: HTTP/SSE-only payloads, exactly-one
// secret source (secretRef XOR secret), the clearSecret-only removal route,
// secret-ref validation, slug derivation, tool-count copy. Wireframe
// admin-assistant-providers.html §MCP Clients (cards 1-4 + no-master-key).
import { describe, it, expect } from "vitest";
import {
  canSubmitMcpForm,
  endpointOf,
  isValidSecretRef,
  MCP_SECRET_MODES,
  MCP_TRANSPORTS,
  mcpFormPayload,
  mcpFormStateFrom,
  requestClearSecret,
  slugifyMcpId,
  toolCountsLabel,
  withSecretField,
  withSecretMode,
  type McpFormState,
} from "./assistant-mcp-logic";

function form(over: Partial<McpFormState> = {}): McpFormState {
  return {
    label: "Linear",
    transportType: "http",
    url: "https://mcp.linear.example/mcp",
    secretMode: "reference",
    secretRef: "",
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

describe("MCP secret source modes", () => {
  it("offers exactly Reference | Managed, in order, with reference first", () => {
    expect(MCP_SECRET_MODES).toEqual([
      { value: "reference", label: "Reference (env: / file:)" },
      { value: "managed", label: "Managed token (stored encrypted)" },
    ]);
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
    expect(mcpFormPayload(form({ secretRef: "plain-token" }))).toBeNull();
  });

  it("accepts env: and file: secret refs and omits an empty one", () => {
    expect(mcpFormPayload(form({ secretRef: "env:LINEAR_MCP_TOKEN" }))).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(mcpFormPayload(form({ secretRef: "file:/run/secrets/linear" }))).toMatchObject({ secretRef: "file:/run/secrets/linear" });
    expect(mcpFormPayload(form({ secretRef: "  " }))).not.toHaveProperty("secretRef");
  });
});

describe("mcpFormPayload — exactly one secret source", () => {
  it("reference mode never carries a managed token", () => {
    const payload = mcpFormPayload(form({ secretMode: "reference", secretRef: "env:LINEAR_MCP_TOKEN" }));
    expect(payload).toMatchObject({ secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(payload).not.toHaveProperty("secret");
  });

  it("managed mode never carries a secret ref", () => {
    const payload = mcpFormPayload(form({ secretMode: "managed", secret: "lin_api_secret" }));
    expect(payload).toMatchObject({ secret: "lin_api_secret" });
    expect(payload).not.toHaveProperty("secretRef");
  });

  it("a managed token is sent verbatim, never shape-validated as a ref", () => {
    expect(mcpFormPayload(form({ secretMode: "managed", secret: "not-an-env-ref" }))).toMatchObject({ secret: "not-an-env-ref" });
  });

  it("never sends both sources even when both fields somehow hold values", () => {
    const payload = mcpFormPayload(form({ secretMode: "managed", secret: "tok", secretRef: "env:LINEAR_MCP_TOKEN" }));
    expect(payload).not.toHaveProperty("secretRef");
    expect(payload).toHaveProperty("secret", "tok");
  });
});

describe("mcpFormPayload — secret-less stays legal", () => {
  it("an empty managed field is a legal secret-less client (neither source)", () => {
    const payload = mcpFormPayload(form({ secretMode: "managed", secret: "" }));
    expect(payload).toEqual({ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp" });
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("secretRef");
    expect(canSubmitMcpForm(form({ secretMode: "managed", secret: "" }))).toBe(true);
  });
});

describe("mcpFormPayload — removal only via clearSecret", () => {
  it("a blank secretRef is never sent expecting a clear (empty means keep)", () => {
    const payload = mcpFormPayload(form({ secretMode: "reference", secretRef: "  " }));
    expect(payload).not.toHaveProperty("secretRef");
    expect(payload).not.toHaveProperty("clearSecret");
    expect(payload?.secretRef).toBeUndefined();
  });

  it("a blank managed secret is never sent expecting a clear", () => {
    const payload = mcpFormPayload(form({ secretMode: "managed", secret: "   " }));
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("clearSecret");
  });

  it("a pending clear sends clearSecret: true and no source at all", () => {
    const payload = mcpFormPayload(requestClearSecret(form({ secretRef: "env:LINEAR_MCP_TOKEN" })));
    expect(payload).toEqual({ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", clearSecret: true });
    expect(payload).not.toHaveProperty("secretRef");
    expect(payload).not.toHaveProperty("secret");
  });

  it("a pending clear from the managed branch also nulls both server-side", () => {
    const payload = mcpFormPayload(requestClearSecret(form({ secretMode: "managed", secret: "tok" })));
    expect(payload).toEqual({ label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", clearSecret: true });
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("secretRef");
  });

  it("a pending clear survives a mode switch — the stored secret must not be resurrected", () => {
    const pending = requestClearSecret(form({ secretMode: "managed" }));
    const switched = withSecretMode(pending, "reference");
    expect(switched.clearPending).toBe(true);
    expect(mcpFormPayload(switched)).toMatchObject({ clearSecret: true });
  });
});

describe("withSecretMode / withSecretField / requestClearSecret", () => {
  it("switching branches drops the other field locally", () => {
    const state = withSecretMode(form({ secretMode: "reference", secretRef: "env:LINEAR_MCP_TOKEN" }), "managed");
    expect(state.secretMode).toBe("managed");
    expect(state.secretRef).toBe("");
    expect(state.secret).toBe("");
  });

  it("selecting the same mode is a no-op", () => {
    const state = form({ secretMode: "reference", secretRef: "env:LINEAR_MCP_TOKEN" });
    expect(withSecretMode(state, "reference")).toBe(state);
  });

  it("typing into either branch cancels a pending clear — the secret is kept", () => {
    const pending = requestClearSecret(form());
    expect(withSecretField(pending, "secretRef", "env:LINEAR_MCP_TOKEN").clearPending).toBe(false);
    expect(withSecretField(pending, "secret", "tok").clearPending).toBe(false);
    expect(mcpFormPayload(withSecretField(pending, "secretRef", "env:LINEAR_MCP_TOKEN"))).not.toHaveProperty("clearSecret");
  });

  it("a confirmed clear empties both fields and raises the flag", () => {
    const state = requestClearSecret(form({ secretMode: "managed", secret: "tok" }));
    expect(state).toMatchObject({ clearPending: true, secret: "", secretRef: "" });
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
  it("defaults a new form to http + Reference, never stdio, and canSubmit tracks validity", () => {
    expect(mcpFormStateFrom(null).transportType).toBe("http");
    expect(mcpFormStateFrom(null).secretMode).toBe("reference");
    expect(canSubmitMcpForm(mcpFormStateFrom(null))).toBe(false);
    expect(canSubmitMcpForm(form({ transportType: "http", url: "https://x/mcp" }))).toBe(true);
  });

  it("prefills the mode select from secretSource and never leaks a secret value", () => {
    expect(mcpFormStateFrom({ label: "Linear", transportType: "sse", url: "https://x/sse", secretSource: "reference" })).toEqual({
      label: "Linear",
      transportType: "sse",
      url: "https://x/sse",
      secretMode: "reference",
      secretRef: "",
      secret: "",
      clearPending: false,
    });
    expect(mcpFormStateFrom({ label: "Linear", transportType: "http", url: "https://x/mcp", secretSource: "managed" }).secretMode).toBe("managed");
    // "none" is a legal secret-less client and falls back to the default branch.
    expect(mcpFormStateFrom({ label: "Linear", transportType: "http", url: "https://x/mcp", secretSource: "none" }).secretMode).toBe("reference");
  });
});
