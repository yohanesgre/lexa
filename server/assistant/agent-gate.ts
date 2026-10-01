// WebSocket gate + internal-route guard for the assistant Durable Object
// (ADR-0003 §B.2). The orchestration here is dependency-injected and Effect-
// free so the 401/404/200 matrix and the header-stripping/signing contract are
// unit-testable without a DB; `server/workers-entry.ts` supplies the real
// auth/thread/project-access implementations.
//
// Flow for `GET /api/assistant/agent/:threadKey` (Upgrade: websocket):
//   1. Better-Auth session cookie → no session → 401 NO_USER_CONTEXT.
//   2. Parse `threadKey = <documentType>:<documentId>`.
//   3. Resolve the D1 thread: chat is owner-scoped (missing row upserts from a
//      validated `?projectId=`); task/wiki require project read access.
//      Missing / not owned / not readable → 404 ASSISTANT_THREAD_NOT_FOUND (no
//      existence leak).
//   4. Strip every inbound `X-Lexa-*` header and mint signed identity headers.
//      A missing master key → 502 ASSISTANT_UNAVAILABLE.

import type { AssistantThreadType } from "../../shared/assistant";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  X_LEXA_HEADER_PREFIX,
  signInternalAuth,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";

export const ASSISTANT_AGENT_ROUTE_PREFIX = "/api/assistant/agent/";
export const INTERNAL_ASSISTANT_ROUTE_PREFIX = "/api/internal/assistant/";

const THREAD_TYPES: ReadonlySet<string> = new Set<AssistantThreadType>(["chat", "task", "wiki"]);

export interface AssistantSession {
  user?: { id: string } | null;
}

export interface AssistantThreadRow {
  documentType: AssistantThreadType;
  documentId: string;
  projectId: string;
  ownerUserId: string | null;
}

export interface UpsertChatThreadInput {
  documentId: string;
  projectId: string;
  ownerUserId: string;
}

export interface AssistantGateDeps {
  getSession: (headers: Headers) => Promise<AssistantSession | null>;
  loadThread: (documentType: AssistantThreadType, documentId: string) => Promise<AssistantThreadRow | null>;
  canReadProject: (userId: string, projectId: string) => Promise<boolean>;
  upsertChatThread: (input: UpsertChatThreadInput) => Promise<AssistantThreadRow | null>;
  masterKey?: string | undefined;
  nowMs?: (() => number) | undefined;
}

export type AssistantGateOutcome =
  | { kind: "forward"; threadKey: string; identity: InternalAuthIdentity; headers: Headers }
  | { kind: "error"; status: number; code: string; message: string };

function gateError(status: number, code: string, message: string): AssistantGateOutcome {
  return { kind: "error", status, code, message };
}

/** `chat:<id>` | `task:<id>` | `wiki:<id>` — URL-encoded as one path segment. */
export function parseThreadKey(value: string): { documentType: AssistantThreadType; documentId: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const documentType = value.slice(0, separator);
  const documentId = value.slice(separator + 1);
  if (!THREAD_TYPES.has(documentType) || documentId.length === 0) return null;
  return { documentType: documentType as AssistantThreadType, documentId };
}

/** Drop every inbound `X-Lexa-*` header (spoof defense before forwarding). */
export function stripInternalHeaders(init: HeadersInit): Headers {
  const headers = new Headers(init);
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith(X_LEXA_HEADER_PREFIX)) headers.delete(name);
  }
  return headers;
}

/** JSON envelope + security headers, matching the repo's error shape. */
export function assistantGateErrorResponse(outcome: Extract<AssistantGateOutcome, { kind: "error" }>): Response {
  return new Response(JSON.stringify({ error: { code: outcome.code, message: outcome.message } }), {
    status: outcome.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleAssistantAgentRequest(
  req: Request,
  deps: AssistantGateDeps
): Promise<AssistantGateOutcome> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(ASSISTANT_AGENT_ROUTE_PREFIX)) {
    return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Unknown assistant route");
  }
  const rawSegment = url.pathname.slice(ASSISTANT_AGENT_ROUTE_PREFIX.length);
  if (rawSegment.length === 0 || rawSegment.includes("/")) {
    return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
  }
  let threadKey: string;
  try {
    threadKey = decodeURIComponent(rawSegment);
  } catch {
    return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
  }
  const parsed = parseThreadKey(threadKey);
  if (!parsed) {
    return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
  }

  const session = await deps.getSession(new Headers(req.headers));
  const userId = session?.user?.id;
  if (!userId) {
    return gateError(401, "NO_USER_CONTEXT", "Sign-in required");
  }

  const row = await deps.loadThread(parsed.documentType, parsed.documentId);
  let projectId: string;
  if (parsed.documentType === "chat") {
    if (row) {
      if (row.ownerUserId !== userId) {
        return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
      }
      projectId = row.projectId;
    } else {
      const requestedProjectId = url.searchParams.get("projectId") ?? "";
      if (requestedProjectId.length === 0 || !(await deps.canReadProject(userId, requestedProjectId))) {
        return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
      }
      const created = await deps.upsertChatThread({
        documentId: parsed.documentId,
        projectId: requestedProjectId,
        ownerUserId: userId,
      });
      if (!created || created.ownerUserId !== userId) {
        return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
      }
      projectId = created.projectId;
    }
  } else {
    if (!row || !(await deps.canReadProject(userId, row.projectId))) {
      return gateError(404, "ASSISTANT_THREAD_NOT_FOUND", "Assistant thread not found");
    }
    projectId = row.projectId;
  }

  if (!deps.masterKey) {
    return gateError(502, "ASSISTANT_UNAVAILABLE", "Assistant not configured");
  }

  const identity: InternalAuthIdentity = { actorUserId: userId, projectId, threadKey };
  const internal = await signInternalAuth(deps.masterKey, identity, deps.nowMs?.() ?? Date.now());
  const headers = stripInternalHeaders(req.headers);
  headers.set(INTERNAL_AUTH_ACTOR_HEADER, identity.actorUserId);
  headers.set(INTERNAL_AUTH_PROJECT_HEADER, identity.projectId);
  headers.set(INTERNAL_AUTH_THREAD_HEADER, identity.threadKey);
  headers.set(INTERNAL_AUTH_HEADER, internal);
  return { kind: "forward", threadKey, identity, headers };
}

export type InternalAuthOutcome = "ok" | "unauthorized" | "unavailable";

/**
 * Guard the `/api/internal/assistant/*` mount (DO → Worker). Only a valid
 * signed identity passes; the mount point itself has no handlers in P1.
 */
export async function authorizeInternalRequest(
  req: Request,
  masterKey: string | undefined
): Promise<InternalAuthOutcome> {
  if (!masterKey) return "unavailable";
  const headers = new Headers(req.headers);
  const identity: InternalAuthIdentity = {
    actorUserId: headers.get(INTERNAL_AUTH_ACTOR_HEADER) ?? "",
    projectId: headers.get(INTERNAL_AUTH_PROJECT_HEADER) ?? "",
    threadKey: headers.get(INTERNAL_AUTH_THREAD_HEADER) ?? "",
  };
  const valid = await verifyInternalAuth(masterKey, headers.get(INTERNAL_AUTH_HEADER), identity);
  return valid ? "ok" : "unauthorized";
}
