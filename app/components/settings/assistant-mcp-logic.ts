import type { McpServerInput, McpTransportType } from "../../lib/api";

// Pure logic for the MCP Clients registry section (wireframe
// admin-assistant-providers.html §MCP Clients; shared with settings-workspace).
// Remote HTTP/SSE only — stdio was removed with migration 0010.

export const MCP_TRANSPORTS: { value: McpTransportType; label: string }[] = [
  { value: "http", label: "http (Streamable HTTP)" },
  { value: "sse", label: "sse (legacy)" },
];

// Mirrors server slugifyMcpId — the id is derived from the label on create.
export function slugifyMcpId(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "mcp-server"
  );
}

export function endpointOf(server: { url: string | null } | null): string {
  if (!server) return "";
  return server.url ?? "";
}

export type McpTestState = {
  state: "pending" | "ok" | "fail";
  latencyMs?: number | undefined;
  toolCount?: number | undefined;
  readOnlyToolCount?: number | undefined;
  code?: string | undefined;
  message?: string | undefined;
};

export function toolCountsLabel(state: McpTestState | undefined): string {
  if (state?.state === "ok" && state.toolCount !== undefined) {
    return `${state.toolCount} total · ${state.readOnlyToolCount ?? 0} read-only`;
  }
  return "Not tested";
}

export type McpFormState = {
  label: string;
  transportType: McpTransportType;
  url: string;
  // The only credential field — a write-only managed token.
  secret: string;
  // A confirmed Clear secret: nothing is cleared until Save writes
  // clearSecret: true. Typing into the field drops back to "keep".
  clearPending: boolean;
};

export function canSubmitMcpForm(state: McpFormState): boolean {
  return mcpFormPayload(state) !== null;
}

// Create/update payload. The token is carried only when non-empty (empty =
// keep), and removal only ever through `clearSecret: true` — a blank `secret`
// must never be sent expecting a clear, because the server keeps the stored one.
export function mcpFormPayload(state: McpFormState): McpFormPayload | null {
  const base = basePayload(state);
  if (!base) return null;

  if (state.clearPending) return { ...base, clearSecret: true };

  const secret = state.secret.trim();
  return secret ? { ...base, secret } : base;
}

export type McpFormPayload = McpServerInput & { clearSecret?: boolean };

function basePayload(state: McpFormState): McpServerInput | null {
  const label = state.label.trim();
  if (!label) return null;
  const url = state.url.trim();
  if (!url) return null;
  return { label, transportType: state.transportType, url };
}

export function mcpFormStateFrom(server: {
  label: string;
  transportType: McpTransportType;
  url: string | null;
} | null): McpFormState {
  if (!server) {
    return { label: "", transportType: "http", url: "", secret: "", clearPending: false };
  }
  return {
    label: server.label,
    transportType: server.transportType,
    url: server.url ?? "",
    // Never prefill a secret value — the server never sends one back.
    secret: "",
    clearPending: false,
  };
}

// Typing into the field cancels a pending clear: the secret is kept.
export function withSecretField(state: McpFormState, value: string): McpFormState {
  return { ...state, secret: value, clearPending: false };
}

export function requestClearSecret(state: McpFormState): McpFormState {
  return { ...state, clearPending: true, secret: "" };
}
