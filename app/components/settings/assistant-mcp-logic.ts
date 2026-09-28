import type { McpSecretSource, McpServerInput, McpTransportType } from "../../lib/api";

// Pure logic for the MCP Clients registry section (wireframe
// admin-assistant-providers.html §MCP Clients; shared with settings-workspace).
// Remote HTTP/SSE only — stdio was removed with migration 0010.

export const MCP_TRANSPORTS: { value: McpTransportType; label: string }[] = [
  { value: "http", label: "http (Streamable HTTP)" },
  { value: "sse", label: "sse (legacy)" },
];

// The mode select is the only source control; exactly one branch renders at a
// time. `reference` is the default branch.
export const MCP_SECRET_MODES: { value: McpSecretMode; label: string }[] = [
  { value: "reference", label: "Reference (env: / file:)" },
  { value: "managed", label: "Managed token (stored encrypted)" },
];

export type McpSecretMode = "reference" | "managed";

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
  secretMode: McpSecretMode;
  // The field of the OTHER branch is never carried, so a payload can never
  // hold both `secret` and `secretRef` (refused server-side).
  secretRef: string;
  secret: string;
  // A confirmed Clear secret: nothing is cleared until Save writes
  // clearSecret: true. Typing into either field drops back to "keep".
  clearPending: boolean;
};

// Shape check only: env: names are allowlisted at save against the server's
// RuntimeEnv snapshot keys, which the browser cannot know.
export function isValidSecretRef(value: string): boolean {
  return /^env:[A-Z0-9_]+$/.test(value) || /^file:\//.test(value);
}

export function canSubmitMcpForm(state: McpFormState): boolean {
  return mcpFormPayload(state) !== null;
}

// Create/update payload. Exactly one source, carried only when non-empty
// (empty = keep), and removal only ever through `clearSecret: true` — a blank
// `secretRef`/`secret` must never be sent expecting a clear, because the server
// keeps the stored one.
export function mcpFormPayload(state: McpFormState): McpFormPayload | null {
  const base = basePayload(state);
  if (!base) return null;

  if (state.clearPending) return { ...base, clearSecret: true };

  if (state.secretMode === "managed") {
    const secret = state.secret.trim();
    return secret ? { ...base, secret } : base;
  }

  const secretRef = state.secretRef.trim();
  if (secretRef && !isValidSecretRef(secretRef)) return null;
  return secretRef ? { ...base, secretRef } : base;
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
  secretSource: McpSecretSource;
} | null): McpFormState {
  if (!server) {
    return { label: "", transportType: "http", url: "", secretMode: "reference", secretRef: "", secret: "", clearPending: false };
  }
  return {
    label: server.label,
    transportType: server.transportType,
    url: server.url ?? "",
    secretMode: server.secretSource === "managed" ? "managed" : "reference",
    // Never prefill a secret value — the server never sends one back.
    secretRef: "",
    secret: "",
    clearPending: false,
  };
}

// Switching branches drops the other field locally (the mode select is the only
// source control). A pending clear is deliberately NOT dropped: the clear
// targets the stored secret, so switching mode must not silently resurrect it.
export function withSecretMode(state: McpFormState, mode: McpSecretMode): McpFormState {
  if (mode === state.secretMode) return state;
  return { ...state, secretMode: mode, secretRef: "", secret: "" };
}

// Typing into either branch cancels a pending clear: the secret is kept.
export function withSecretField(state: McpFormState, field: "secretRef" | "secret", value: string): McpFormState {
  return { ...state, [field]: value, clearPending: false };
}

export function requestClearSecret(state: McpFormState): McpFormState {
  return { ...state, clearPending: true, secretRef: "", secret: "" };
}
