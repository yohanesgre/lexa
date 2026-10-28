// Inbound MCP boundary: POST /mcp over Streamable HTTP (stateless).
//
// Order, mirroring /api: rate limit (shared per-IP bucket) → personal bearer
// auth (fresh on every request; no cookie channel) → per-request SDK server +
// transport (JSON responses, streamed body cap, Origin allow-list) → disposal.
// Auth failures and limit violations use the REST envelope; MCP protocol
// traffic gets the SDK's JSON-RPC responses. No provider/master-key state is
// consulted, so the endpoint is independent of AI configuration.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { resolveMaxApiBody } from "../api/limits";
import { apiRateLimiter } from "../api/rate-limit";
import { resolveTrustedOrigins, type RuntimeEnv } from "../env";
import { MCP_SERVER_INFO, registerLexaTools } from "./catalog";
import type { McpAuthenticate, McpIdentity, McpRestDispatch } from "./rest";

export const MCP_PATH = "/mcp";

// The server would otherwise build a fresh Ajv instance for every per-request
// McpServer; one validator per process/isolate keeps request construction cheap
// (it validates elicitation form input, which this server never requests).
const jsonSchemaValidator = new AjvJsonSchemaValidator();

export interface McpBoundaryDeps {
  env: RuntimeEnv;
  /** Client IP resolved by the host entry (socket on Bun, edge header on Workers). */
  clientIp: string;
  authenticate: McpAuthenticate;
  dispatch: McpRestDispatch;
}

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonEnvelope(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return jsonEnvelope({ jsonrpc: "2.0", error: { code, message }, id: null }, status);
}

// Origin values must be bare origins: LXK_PUBLIC_URL / LXK_TRUSTED_ORIGINS are
// URLs, while the request header is scheme://host[:port]. The public URL is
// also the dispatch parser anchor, so nothing derives from the request Host.
function allowedOrigins(env: RuntimeEnv): string[] {
  const origins = new Set<string>();
  for (const value of resolveTrustedOrigins(env)) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      const trimmed = value.replace(/\/+$/, "");
      if (trimmed.length > 0) origins.add(trimmed);
    }
  }
  return [...origins];
}

export async function handleMcpRequest(req: Request, deps: McpBoundaryDeps): Promise<Response> {
  // One charge per MCP HTTP request on the shared API bucket; the in-process
  // dispatch for a tool call carries the internal marker so the route stack
  // does not charge the same request again.
  if (!apiRateLimiter.check(deps.clientIp)) {
    const retryAfter = Math.max(1, Math.ceil(apiRateLimiter.retryAfterMs(deps.clientIp) / 1000));
    console.warn(`[MCP] rate limited ip=${deps.clientIp} retryAfter=${retryAfter}s`);
    return secured(
      jsonEnvelope({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } }, 429, {
        "Retry-After": String(retryAfter),
      })
    );
  }

  // Stateless single-endpoint transport: no server-initiated SSE stream (GET)
  // and no session to terminate (DELETE), so both are refused explicitly
  // instead of leaving a stream open that disposal would immediately close.
  if (req.method !== "POST") {
    return secured(
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: "POST" },
      })
    );
  }

  const authHeader = req.headers.get("authorization") ?? "";
  let identity: McpIdentity | null = null;
  try {
    identity = await deps.authenticate(authHeader);
  } catch {
    identity = null;
  }
  // Personal keys only: a session cookie is never read here and an unbound
  // legacy/server key (user_id NULL) cannot establish a personal identity.
  if (!identity || typeof identity.userId !== "string" || identity.userId.length === 0) {
    const reason = authHeader.startsWith("Bearer ") ? "unknown or unbound key" : "missing or malformed key";
    console.warn(`[MCP] denied reason=${reason}`);
    return secured(jsonEnvelope({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }, 401));
  }

  const server = new McpServer(MCP_SERVER_INFO, { jsonSchemaValidator });
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: sessionIdGenerator is omitted (absent => stateless), so no
    // session id, no server-held auth, safe on any instance.
    // Tools are request/response; JSON avoids held SSE streams per call.
    enableJsonResponse: true,
    // Same cap as /api: LXK_MAX_BODY_MB, declared and streamed.
    maxRequestBodySize: resolveMaxApiBody(deps.env),
    // Origin must match the configured canonical/trusted origins when present;
    // an absent Origin (non-browser MCP client) is accepted.
    enableDnsRebindingProtection: true,
    allowedOrigins: allowedOrigins(deps.env),
  });
  transport.onerror = (error) => console.warn(`[MCP] transport error: ${error.message}`);

  try {
    registerLexaTools(server, deps.dispatch);
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    return secured(response);
  } catch (error) {
    console.error("[MCP] request failed:", error instanceof Error ? error.message : String(error));
    return secured(jsonRpcError(500, -32603, "Internal error"));
  } finally {
    // Per-request server + transport: release both once the response is built.
    try {
      await server.close();
    } catch {}
  }
}
