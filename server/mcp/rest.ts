// Contract between the inbound MCP boundary (`server/mcp/**`) and whichever
// host entry mounts it. The boundary knows nothing about SQL, Effect, or the
// network: every tool call becomes a synthesized in-process Request against the
// SAME authenticated REST handler `/api` uses, so the complete route
// orchestration (middleware, authorization, domain services, route-level GitHub
// sync) runs unchanged. No self-fetch, no caller-chosen origin, no cookie.

import { getInternalMcpToken, X_LEXA_INTERNAL_MCP } from "../api/limits";

export interface McpRestCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

/** Dispatches one approved REST operation; resolves with its HTTP response. */
export type McpRestDispatch = (call: McpRestCall) => Promise<Response>;

/** A user-bound personal API key after the boundary's freshness check. */
export interface McpIdentity {
  keyId: string;
  keyName: string;
  userId: string;
  userName: string | null;
  role: "admin" | "member";
}

/** Resolves a bearer header to a user-bound identity, or null when denied. */
export type McpAuthenticate = (authHeader: string) => Promise<McpIdentity | null>;

export interface McpDispatchOptions {
  authHeader: string;
  baseUrl: string;
}

// Builds the dispatch for one MCP request. Only three headers cross into the
// inner request — the caller's bearer, the JSON content type, and the internal
// nonce — so an inbound cookie or forwarding header can never influence the
// dispatched operation's identity. The base URL is only a parser anchor for the
// absolute Request (the REST stack reads pathname + query).
export function createRestDispatch(
  handler: (req: Request) => Promise<Response>,
  options: McpDispatchOptions
): McpRestDispatch {
  return ({ method, path, body }) => {
    const headers: Record<string, string> = {
      authorization: options.authHeader,
      [X_LEXA_INTERNAL_MCP]: getInternalMcpToken(),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return handler(new Request(new URL(path, options.baseUrl), init));
  };
}
