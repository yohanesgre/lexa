import type { McpServerInput, McpTransportType } from "../../lib/api";

// Pure logic for the MCP Servers registry section (wireframe
// admin-assistant-providers.html §MCP Servers; shared with settings-workspace).

export const MCP_SEEDED_ID = "jev";

export const MCP_TRANSPORTS: { value: McpTransportType; label: string }[] = [
  { value: "http", label: "http (Streamable HTTP)" },
  { value: "sse", label: "sse (legacy)" },
  { value: "stdio", label: "stdio (same host only)" },
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

export function isSeededMcpServer(server: { id: string }): boolean {
  return server.id === MCP_SEEDED_ID;
}

export function endpointOf(server: { transportType: McpTransportType; url: string | null; command: string | null } | null): string {
  if (!server) return "";
  return (server.transportType === "stdio" ? server.command : server.url) ?? "";
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
  command: string;
  args: string;
  secretRef: string;
};

// JSON array of argv tokens; empty input means no args. Returns null on
// non-array / non-string entries so the form can flag the field invalid.
export function parseArgs(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

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

  const args = parseArgs(state.args);
  if (args === null) return null;

  const secret = state.secretRef.trim();
  if (secret && !isValidSecretRef(secret)) return null;

  const payload: McpServerInput = { label, transportType: state.transportType, args };
  if (state.transportType === "stdio") {
    const command = state.command.trim();
    if (!command) return null;
    payload.command = command;
  } else {
    const url = state.url.trim();
    if (!url) return null;
    payload.url = url;
  }
  if (secret) payload.secretRef = secret;
  return payload;
}

export function mcpFormStateFrom(server: {
  label: string;
  transportType: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
} | null): McpFormState {
  if (!server) return { label: "", transportType: "stdio", url: "", command: "", args: "", secretRef: "" };
  return {
    label: server.label,
    transportType: server.transportType,
    url: server.url ?? "",
    command: server.command ?? "",
    args: server.args.length > 0 ? JSON.stringify(server.args) : "",
    secretRef: "",
  };
}
