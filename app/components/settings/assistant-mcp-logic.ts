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
  secretRef: string;
};

// Shape check only: env: names are allowlisted at save against the server's
// RuntimeEnv snapshot keys, which the browser cannot know.
export function isValidSecretRef(value: string): boolean {
  return /^env:[A-Z0-9_]+$/.test(value) || /^file:\//.test(value);
}

export function canSubmitMcpForm(state: McpFormState): boolean {
  return mcpFormPayload(state) !== null;
}

// Create payload (the id is server-derived from the label). On edit an empty
// secret reference is omitted so the stored reference is kept.
export function mcpFormPayload(state: McpFormState): McpServerInput | null {
  const label = state.label.trim();
  if (!label) return null;

  const url = state.url.trim();
  if (!url) return null;

  const secret = state.secretRef.trim();
  if (secret && !isValidSecretRef(secret)) return null;

  const payload: McpServerInput = { label, transportType: state.transportType, url };
  if (secret) payload.secretRef = secret;
  return payload;
}

export function mcpFormStateFrom(server: {
  label: string;
  transportType: McpTransportType;
  url: string | null;
} | null): McpFormState {
  if (!server) return { label: "", transportType: "http", url: "", secretRef: "" };
  return {
    label: server.label,
    transportType: server.transportType,
    url: server.url ?? "",
    secretRef: "",
  };
}
