// Worker-side handlers for the DO → Worker internal routes (ADR-0003 §B.2/B.3).
// These are mounted in `server/workers-entry.ts` behind the HMAC guard
// (`authorizeInternalRequest`) and operate on the async `DbDriver` the worker
// factory already holds. Kept pure of `Request` parsing where possible so the
// D1 read/write contract is unit-testable with a bun-sqlite driver.
//
//   GET  /api/internal/assistant/legacy/<threadKey>  → { messages }
//   POST /api/internal/assistant/mirror              → { ok: true }
//   POST /api/internal/assistant/tool                → { ok, result, error }   (read tool)
//   POST /api/internal/assistant/write-tool          → { proposed, approvalId, error } (write proposal)
//   POST /api/internal/assistant/write-execute       → { ok, applied, result, error, partial } (auto-mode write)

import { Effect } from "effect";
import type { DbDriver } from "../db/db";
import {
  batch,
  queryFirst,
  run,
  runReturning,
  RowNotFound,
  type BatchStmt,
  type ConstraintViolation,
  type DbError,
  type SqlParam,
} from "../db/db";
import { parseThreadKey } from "./agent-gate";
import type { RegistryModelConfig } from "./model-factory";
import type { AssistantCallLogInput, AssistantCallLogStatus, ProviderKind } from "../../shared/assistant";
import { assistantCancelled, assistantCompleted, assistantFailed } from "../activity-messages";
import { APPROVAL_TTL_HOURS, MAX_WRITES_PER_TURN } from "./write-tool-names";
import {
  buildAssistantWriteTools,
  isAssistantWriteTool,
  type AssistantWriteToolDeps,
  type WriteTaskSnapshot,
} from "./write-tools";
import type { ReadToolResponse, WriteExecuteResponse } from "./tools-ai";
import type { RepoContentEntry } from "../services/assistant-repo-content";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc } from "../../shared/types";
import type { AssistantRunKind, AssistantRunStatus } from "../../shared/assistant";
import {
  countActiveRuns,
  createAssistantRun,
  getAssistantRun,
  transitionAssistantRunRegistry,
} from "./run-registry";

export interface MirrorThreadInput {
  threadKey: string;
  projectId: string;
  messages: unknown[];
  summary: string | null;
  // `null` preserves the existing column (engine value not supplied yet);
  // a number replaces it. See `MirrorTranscriptInput` in agent-runtime.ts.
  summarizedCount: number | null;
  title: string | null;
}

interface ThreadRow {
  messages: string;
}

// Read the D1 mirror row's raw messages for a thread key. `null` means "no row
// or empty transcript" — nothing to import (migrate-on-read is a no-op).
export function readLegacyThread(
  driver: DbDriver,
  documentType: string,
  documentId: string
): Effect.Effect<unknown[] | null, DbError> {
  return queryFirst<ThreadRow>(
    driver,
    `SELECT messages FROM assistant_threads WHERE document_type = ? AND document_id = ?`,
    documentType,
    documentId
  ).pipe(
    Effect.map((row) => {
      try {
        const parsed = JSON.parse(row.messages);
        return Array.isArray(parsed) && parsed.length > 0 ? (parsed as unknown[]) : null;
      } catch {
        return null;
      }
    }),
    Effect.catchTag("RowNotFound", () => Effect.succeed(null))
  );
}

// Upsert semantics match `AssistantThreadRepo.saveThread`: project/owner are not
// written here (the D1 row already exists — the gate upserts chat rows and the
// task/wiki surfaces create theirs); title backfills only when still NULL, and
// summary/summarized_count only when the caller supplies a non-NULL value.
// A missing row (no thread surface created it) is warned, not silently dropped.
export function mirrorThread(
  driver: DbDriver,
  input: MirrorThreadInput
): Effect.Effect<{ ok: true }, ConstraintViolation | DbError> {
  const parsed = parseThreadKey(input.threadKey);
  if (!parsed) return Effect.succeed({ ok: true });
  return runReturning<{ document_id: string }>(
    driver,
    `UPDATE assistant_threads
     SET messages = ?,
         summary = COALESCE(?, assistant_threads.summary),
         summarized_count = COALESCE(?, assistant_threads.summarized_count),
         title = COALESCE(assistant_threads.title, ?),
         updated_at = datetime('now')
     WHERE document_type = ? AND document_id = ?
     RETURNING document_id`,
    JSON.stringify(input.messages),
    input.summary,
    input.summarizedCount,
    input.title,
    parsed.documentType,
    parsed.documentId
  ).pipe(
    Effect.as({ ok: true as const }),
    Effect.catchTag("RowNotFound", () =>
      Effect.logWarning(
        `[Assistant] mirror: no assistant_threads row for ${parsed.documentType}:${parsed.documentId}`
      ).pipe(Effect.as({ ok: true as const }))
    )
  );
}

// ── Call-log writes (ADR-0003 §C/§D; P3) ───────────────────────────────────
// One `assistant_call_logs` row per provider call, written by the Worker (the
// DO never touches D1 directly). Mirrors `AssistantCallLogsRepo.insert`; the id
// is generated here because the DO's per-turn payload carries no id.

const CALL_LOG_KINDS: ReadonlySet<string> = new Set<ProviderKind>([
  "openai_compatible",
  "anthropic_compatible",
  "openai_responses",
]);
const CALL_LOG_STATUSES: ReadonlySet<string> = new Set<AssistantCallLogStatus>([
  "done",
  "error",
  "suspended",
  "aborted",
]);

export function insertCallLog(
  driver: DbDriver,
  input: AssistantCallLogInput
): Effect.Effect<{ ok: true }, ConstraintViolation | DbError> {
  return run(
    driver,
    `INSERT INTO assistant_call_logs (id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    input.projectId ?? null,
    input.providerId ?? null,
    input.model,
    input.kind,
    input.status,
    input.errorCode ?? null,
    input.usageIn ?? 0,
    input.usageOut ?? 0,
    input.cachedIn ?? 0,
    input.latencyMs ?? null,
    input.costCents ?? 0,
    input.estimated ? 1 : 0
  ).pipe(Effect.as({ ok: true as const }));
}

// ── Terminal run-status transitions (ADR-0003 §B.5/§D; invariant #12) ──────
// Mirrors `AssistantTaskRepo.updateTaskStatus` + `AssistantTaskService`'s
// `emitTerminal`: the status write and the terminal activity emission happen in
// ONE transaction. Only `document_type='task'` runs emit a timeline row.

export type AssistantRunTerminalStatus = "completed" | "failed" | "cancelled";

export interface AssistantRunStatusInput {
  runId: string;
  status: AssistantRunTerminalStatus;
  result?: string | null | undefined;
  error?: string | null | undefined;
}

interface RunRow {
  id: string;
  document_type: string;
  document_id: string;
  agent_id: string;
  status: string;
  agent_name: string;
}

function terminalActivity(status: AssistantRunTerminalStatus, agentName: string): { type: string; message: string } {
  if (status === "completed") return { type: "assistant_completed", message: assistantCompleted(agentName) };
  if (status === "failed") return { type: "assistant_failed", message: assistantFailed() };
  return { type: "assistant_cancelled", message: assistantCancelled() };
}

// The statuses a run may transition FROM for a given terminal target. Mirrors
// the `WHERE` clause below; used by the pre-read idempotency gate.
function isTransitionable(status: string, target: AssistantRunTerminalStatus): boolean {
  if (target === "cancelled") return status === "queued" || status === "running";
  return status === "running";
}

export function transitionAssistantRun(
  driver: DbDriver,
  input: AssistantRunStatusInput
): Effect.Effect<{ ok: true; emitted: boolean }, RowNotFound | ConstraintViolation | DbError> {
  return Effect.gen(function* () {
    // Pre-read is both the 404 gate and the idempotency gate: an unknown run is
    // a RowNotFound (→ 404); a run already terminal for this target is a clean
    // no-op with NO activity row. A retried transition (the DO's `postInternal`
    // retries once on transport failure) therefore never duplicates
    // `task_activity`.
    const row = yield* queryFirst<RunRow>(
      driver,
      `SELECT t.id, t.document_type, t.document_id, t.agent_id, t.status,
              COALESCE(a.name, t.agent_id) AS agent_name
       FROM assistant_tasks t LEFT JOIN lexa_agents a ON a.id = t.agent_id
       WHERE t.id = ?`,
      input.runId
    );
    if (!isTransitionable(row.status, input.status)) {
      return { ok: true as const, emitted: false };
    }

    const sets = ["status = ?", "finished_at = datetime('now')"];
    const params: SqlParam[] = [input.status];
    if (input.result !== undefined) {
      sets.push("result = ?");
      params.push(input.result === null ? null : input.result.slice(0, 1024 * 1024));
    }
    if (input.error !== undefined) {
      sets.push("error = ?");
      params.push(input.error === null ? null : input.error.slice(0, 2000));
    }
    const from = input.status === "cancelled" ? "status IN ('queued', 'running')" : "status = 'running'";

    const emitted = row.document_type === "task";
    const stmts: BatchStmt[] = [
      {
        sql: `UPDATE assistant_tasks SET ${sets.join(", ")} WHERE id = ? AND ${from}`,
        params: [...params, input.runId],
      },
    ];
    if (emitted) {
      const activity = terminalActivity(input.status, row.agent_name);
      // Invariant #12 on BOTH drivers: the status UPDATE and the activity INSERT
      // ride one atomic batch. On bun-sqlite `driver.batch` wraps the pair in
      // BEGIN/COMMIT; on D1 the binding's `batch()` is atomic. The INSERT is
      // additionally gated on `changes() > 0`, so a concurrently-lost UPDATE
      // race cannot emit a spurious row either.
      stmts.push({
        sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
              SELECT t.document_id, 'agent', t.agent_name, NULL, ?, ?, 0
              FROM (SELECT at.document_id, COALESCE(a.name, at.agent_id) AS agent_name
                    FROM assistant_tasks at LEFT JOIN lexa_agents a ON a.id = at.agent_id
                    WHERE at.id = ? AND at.document_type = 'task') t
              WHERE changes() > 0`,
        params: [activity.type, activity.message, input.runId],
      });
    }
    yield* batch(driver, stmts);
    return { ok: true as const, emitted };
  });
}

// ── Write proposals (ADR-0003 §B.5/§D; P3 WS3) ─────────────────────────────
// The DO sends `{ name, args }`; the Worker rebuilds the SAME write toolset the
// Bun path uses (`buildAssistantWriteTools`) with D1-backed snapshot deps, so
// validation, diff building and error copy are byte-identical. `record`
// persists the pending row the approval flow later decides.

export interface AssistantWriteToolRequest {
  name: string;
  args: Record<string, unknown>;
  batchId: string;
  seq: number;
  projectId: string;
  documentType: "task" | "wiki" | "chat";
  documentId: string;
  ownerUserId: string;
  // Run attribution (ADR-0004 §3; plan line 140): the run that proposed this
  // write, when the caller is a delegated runner.
  runId?: string | undefined;
}

function sqlTimestampPlusHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

function parseTipTap(raw: string | null | undefined): TipTapDoc {
  if (!raw) return { type: "doc", content: [] } as TipTapDoc;
  try {
    return JSON.parse(raw) as TipTapDoc;
  } catch {
    return { type: "doc", content: [] } as TipTapDoc;
  }
}

// W7b/WS1: the write tool only returns `{ proposed, approvalId }`; the Worker
// captures the proposal's diff/detail here so `executeAssistantWriteTool` can
// hand them back with the response, letting the DO build the persisted
// `data-assistant-approval` carrier and the live adapter rebuild the chip.
export interface CapturedWriteProposal {
  diff?: unknown;
  detail?: string;
  name?: string;
}

/** D1-backed snapshot deps for the write toolset (same shapes as the service). */
function writeToolDeps(
  driver: DbDriver,
  input: AssistantWriteToolRequest,
  capture?: CapturedWriteProposal
): AssistantWriteToolDeps {
  const one = <T>(sql: string, ...params: unknown[]): Promise<T | null> =>
    Effect.runPromise(queryFirst<T>(driver, sql, ...params)).catch(() => null);
  return {
    projectId: input.projectId,
    findTaskByRef: async (ref: string) => {
      const row = await one<{
        id: string;
        key: string | null;
        title: string;
        priority: string;
        type: string;
        due_at: string | null;
        archived_at: string | null;
        description: string;
        column_name: string | null;
        assignee_names: string | null;
      }>(
        `SELECT t.id, t.key, t.title, t.priority, t.type, t.due_at, t.archived_at, t.description,
                c.name AS column_name, GROUP_CONCAT(ta.user_name, '||') AS assignee_names
         FROM tasks t LEFT JOIN columns c ON t.column_id = c.id
         LEFT JOIN task_assignees ta ON ta.task_id = t.id
         WHERE t.project_id = ? AND (t.id = ? OR t.key = ?)
         GROUP BY t.id LIMIT 1`,
        input.projectId,
        ref,
        ref
      );
      if (!row) return null;
      const assignees = row.assignee_names ? row.assignee_names.split("||") : [];
      const snapshot: WriteTaskSnapshot = {
        id: row.id,
        key: row.key ?? row.id,
        title: row.title,
        columnName: row.column_name ?? "",
        priority: row.priority,
        type: row.type,
        dueAt: row.due_at,
        assignees,
        descriptionText: extractText(parseTipTap(row.description)),
        archivedAt: row.archived_at,
      };
      return snapshot;
    },
    findColumn: (id: string) => one<{ id: string; name: string }>(
      `SELECT id, name FROM columns WHERE id = ? AND project_id = ?`,
      id,
      input.projectId
    ),
    findWikiPageBySlug: (slug: string) => one<{ slug: string; title: string; text: string }>(
      `SELECT slug, title, content_text AS text FROM wiki_pages WHERE project_id = ? AND slug = ?`,
      input.projectId,
      slug
    ),
    findMilestone: (id: string) => one<{ id: string; name: string; dueAt: string | null; archivedAt: string | null }>(
      `SELECT id, name, due_at AS dueAt, archived_at AS archivedAt FROM milestones WHERE id = ? AND project_id = ?`,
      id,
      input.projectId
    ),
    findSwimlane: (id: string) => one<{
      id: string;
      name: string;
      kind: "backlog" | "milestone" | "sprint";
      archivedAt: string | null;
      milestoneId: string | null;
    }>(
      `SELECT id, name, kind, archived_at AS archivedAt, milestone_id AS milestoneId FROM swimlanes WHERE id = ? AND project_id = ?`,
      id,
      input.projectId
    ),
    countSprints: async (milestoneId: string) => {
      const row = await one<{ c: number }>(
        `SELECT COUNT(*) AS c FROM swimlanes WHERE milestone_id = ? AND kind = 'sprint' AND archived_at IS NULL`,
        milestoneId
      );
      return row?.c ?? 0;
    },
    record: async (proposal) => {
      const approvalId = crypto.randomUUID();
      if (capture) {
        capture.diff = proposal.diff;
        capture.name = proposal.name;
        if (proposal.detail !== undefined) capture.detail = proposal.detail;
      }
      try {
        const existing = await one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM assistant_pending_writes WHERE project_id = ? AND batch_id = ?`,
          input.projectId,
          input.batchId
        );
        if ((existing?.n ?? 0) >= MAX_WRITES_PER_TURN) {
          return { error: `write budget exceeded — at most ${MAX_WRITES_PER_TURN} proposals per turn` };
        }
        await Effect.runPromise(
          run(
            driver,
            `INSERT INTO assistant_pending_writes
               (id, project_id, document_type, document_id, owner_user_id, batch_id, seq,
                tool_name, args, diff, status, expires_at, proposed_by_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            approvalId,
            input.projectId,
            input.documentType,
            input.documentId,
            input.ownerUserId,
            input.batchId,
            input.seq,
            proposal.name,
            JSON.stringify(proposal.args),
            JSON.stringify(proposal.diff),
            sqlTimestampPlusHours(APPROVAL_TTL_HOURS),
            input.runId ?? null
          )
        );
      } catch (e) {
        return { error: e instanceof Error ? e.message : "failed to queue write" };
      }
      return { approvalId, batchId: input.batchId, seq: input.seq };
    },
  };
}

/**
 * Execute one write tool as a *proposal*: validate + build the diff + persist
 * the pending row, all through the Worker's authoritative write toolset.
 */
export async function executeAssistantWriteTool(
  driver: DbDriver,
  input: AssistantWriteToolRequest
): Promise<InternalAssistantRouteResult> {
  if (!isAssistantWriteTool(input.name)) {
    return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: `Unknown write tool: ${input.name}` } } };
  }
  const capture: CapturedWriteProposal = {};
  const tools = buildAssistantWriteTools(writeToolDeps(driver, input, capture));
  const target = tools.find((t) => t.name === input.name);
  const execute = (target as { execute?: (args: unknown) => Promise<unknown> } | undefined)?.execute;
  if (!execute) {
    return { status: 502, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "Write tool not wired" } } };
  }
  try {
    const result = await execute(input.args ?? {});
    // Only a successful proposal carries the captured chip payload; a failed
    // execute must stay `{ proposed: false, error }` untouched.
    const body =
      result !== null &&
      typeof result === "object" &&
      (result as { proposed?: unknown }).proposed === true
        ? {
            ...(result as Record<string, unknown>),
            batchId: input.batchId,
            name: capture.name ?? input.name,
            ...(capture.detail !== undefined ? { detail: capture.detail } : {}),
            ...(capture.diff !== undefined ? { diff: capture.diff } : {}),
            ...(input.runId !== undefined ? { proposedByRunId: input.runId } : {}),
          }
        : result;
    return { status: 200, body };
  } catch (e) {
    return {
      status: 500,
      body: { error: { code: "ASSISTANT_WRITE_FAILED", message: e instanceof Error ? e.message : "write proposal failed" } },
    };
  }
}

export interface InternalAssistantRouteResult {
  status: number;
  body: unknown;
}

/** Wire body for the per-turn harness context bundle (ADR-0004 §1). */
export interface HarnessTurnContextRequest {
  threadKey: string;
  runId?: string | undefined;
  userText: string;
  mode: "turn" | "resume" | "runner";
}

/**
 * The DO's per-turn context bundle (ADR-0004 §1, Appendix A). Assembled
 * Worker-side; identity (project/actor/thread) is authoritative from the HMAC
 * headers, never from the body. Redacted: no key material, no allowlist values
 * — only the `hasSearchKey`/`jevConfigured` booleans cross the boundary.
 */
export interface HarnessTurnContext {
  projectId: string;
  threadKey: string;
  documentType: "chat" | "task" | "wiki";
  agent: { id: string; name: string; instructions: string } | null;
  skillMarkdowns: string[];
  skillCatalog: string | null;
  memoryBlock: string | null;
  docContext: string | null;
  repoContent: RepoContentEntry[];
  mentionContext: string | null;
  advisory: string | null;
  threadSummary: { summary: string; summarizedCount: number } | null;
  readTools: string[];
  mcpTools: Array<{ name: string; description: string; inputSchema: unknown }>;
  writeTools: string[];
  primarySupportsImages: boolean;
  hasSearchKey: boolean;
  jevConfigured: boolean;
  delegation: { enabled: boolean; maxConcurrentRuns: number };
}

/**
 * Worker-side capabilities the DO calls back into (ADR-0003 §B.2/§C). Injected
 * from `server/workers-entry.ts` so this dispatcher stays IO-free and testable
 * with a plain object.
 */
export interface InternalAssistantDeps {
  /**
   * Resolve the per-project provider chain (primary + ≤2 fallbacks) with the
   * API keys decrypted in the Worker. `null` when the project has no provider
   * binding (→ 409 PROVIDER_NOT_CONFIGURED).
   */
  resolveProviderConfigs?: ((projectId: string) => Promise<RegistryModelConfig[] | null>) | undefined;
  /**
   * Resolve the project's per-turn harness context bundle (ADR-0004 §1). The
   * Worker assembles agent/skill/memory/doc/mention/repo/Jev/summary + tool
   * gating and returns it redacted. Unwired → 502; the DO then falls back to
   * the core read set and no write tools.
   */
  resolveHarnessTurnContext?:
    | ((input: HarnessTurnContextRequest & { projectId: string }) => Promise<HarnessTurnContext>)
    | undefined;
  /**
   * Execute one read tool in the Worker (project data, storage, Jev, Exa).
   * Unwired → 502 so the DO reports ASSISTANT_UNAVAILABLE rather than hanging.
   */
  executeReadTool?:
    | ((input: { name: string; args: Record<string, unknown>; projectId: string; actorUserId: string; agentId?: string }) => Promise<ReadToolResponse>)
    | undefined;
  /**
   * Apply one write immediately in the Worker (auto mode, D4). Owns the
   * extracted `applyAssistantWrite` path; unwired → 502.
   */
  executeWriteTool?:
    | ((input: { name: string; args: Record<string, unknown>; projectId: string; ownerUserId: string }) => Promise<WriteExecuteResponse>)
    | undefined;
}

/**
 * Dispatch one authenticated `/api/internal/assistant/*` request. Returns a
 * `{ status, body }` result so the caller (workers-entry) can serialise it in
 * the same envelope as the rest of the worker. Unknown paths → 404.
 */
export async function handleInternalAssistantRequest(input: {
  method: string;
  path: string;
  query?: Record<string, string> | undefined;
  body: unknown;
  driver: DbDriver;
  deps?: InternalAssistantDeps | undefined;
  /** Verified internal identity attached by the mount guard (project/actor). */
  identity?: { actorUserId: string; projectId: string; threadKey: string } | undefined;
}): Promise<InternalAssistantRouteResult> {
  const { method, path, driver } = input;

  // Provider config for one turn (ADR-0003 §C): decrypted in the Worker, used
  // in memory by the DO, never persisted. The DO attaches its own
  // `sessionId` (x-opencode-session) when it builds the model.
  if (method === "GET" && path === "/api/internal/assistant/provider-config") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal project identity" } } };
    }
    const requested = input.query?.["projectId"] ?? "";
    if (requested.length > 0 && requested !== identity.projectId) {
      return { status: 403, body: { error: { code: "NO_USER_CONTEXT", message: "project identity mismatch" } } };
    }
    if (!input.deps?.resolveProviderConfigs) {
      return { status: 502, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "Provider resolution not wired" } } };
    }
    const configs = await input.deps.resolveProviderConfigs(identity.projectId);
    if (configs === null || configs.length === 0) {
      return { status: 409, body: { error: { code: "PROVIDER_NOT_CONFIGURED", message: "No provider binding for this project" } } };
    }
    return { status: 200, body: { configs } };
  }

  // Per-turn harness context bundle (ADR-0004 §1; H1). The DO POSTs its
  // thread/run/userText/mode; the signed identity is authoritative for the
  // project/actor/thread, and the body may never override it. Redacted response:
  // booleans (`hasSearchKey`/`jevConfigured`) and tool names/descriptors only.
  if (method === "POST" && path === "/api/internal/assistant/turn-context") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0 || identity.threadKey.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const bodyThreadKey = typeof payload.threadKey === "string" ? payload.threadKey : "";
    const userText = typeof payload.userText === "string" ? payload.userText : null;
    const mode = payload.mode;
    if (bodyThreadKey.length === 0 || userText === null || (mode !== "turn" && mode !== "resume" && mode !== "runner")) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid turn-context payload" } } };
    }
    // Signed identity wins: a body thread that does not address this DO instance
    // is rejected, never used.
    if (bodyThreadKey !== identity.threadKey) {
      return { status: 403, body: { error: { code: "NO_USER_CONTEXT", message: "identity mismatch" } } };
    }
    if (!input.deps?.resolveHarnessTurnContext) {
      return { status: 502, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "Turn-context resolution not wired" } } };
    }
    const runId = typeof payload.runId === "string" && payload.runId.length > 0 ? payload.runId : undefined;
    try {
      const context = await input.deps.resolveHarnessTurnContext({
        projectId: identity.projectId,
        threadKey: identity.threadKey,
        userText,
        mode,
        ...(runId !== undefined ? { runId } : {}),
      });
      return { status: 200, body: { context } };
    } catch (e) {
      return {
        status: 500,
        body: { error: { code: "ASSISTANT_UNAVAILABLE", message: e instanceof Error ? e.message : "turn-context failed" } },
      };
    }
  }

  // Read tool execution (ADR-0003 §B.5; P3 WS3): the DO dispatches the model's
  // read call here; the Worker owns project data, storage and third-party keys.
  if (method === "POST" && path === "/api/internal/assistant/tool") {
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name : "";
    if (name.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "tool name is required" } } };
    }
    const projectId = input.identity?.projectId ?? "";
    if (projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal project identity" } } };
    }
    if (!input.deps?.executeReadTool) {
      return { status: 502, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "Read-tool execution not wired" } } };
    }
    const args = (typeof payload.args === "object" && payload.args !== null ? payload.args : {}) as Record<string, unknown>;
    const agentId = typeof payload.agentId === "string" && payload.agentId.length > 0 ? payload.agentId : undefined;
    const result = await input.deps.executeReadTool({
      name,
      args,
      projectId,
      actorUserId: input.identity?.actorUserId ?? "",
      ...(agentId !== undefined ? { agentId } : {}),
    });
    return { status: 200, body: result };
  }

  // Write proposal (ADR-0003 §B.5/§D; P3 WS3): the DO's write tool maps to a
  // pending row; the existing approval flow decides and executes it.
  if (method === "POST" && path === "/api/internal/assistant/write-tool") {
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0 || identity.actorUserId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const name = typeof payload.name === "string" ? payload.name : "";
    const batchId = typeof payload.batchId === "string" ? payload.batchId : "";
    const bodyProjectId = typeof payload.projectId === "string" ? payload.projectId : "";
    const documentId = typeof payload.documentId === "string" ? payload.documentId : "";
    const bodyOwnerUserId = typeof payload.ownerUserId === "string" ? payload.ownerUserId : "";
    const documentType = payload.documentType;
    const seq = typeof payload.seq === "number" && Number.isInteger(payload.seq) ? payload.seq : -1;
    if (
      name.length === 0 ||
      batchId.length === 0 ||
      bodyProjectId.length === 0 ||
      documentId.length === 0 ||
      bodyOwnerUserId.length === 0 ||
      seq < 0 ||
      (documentType !== "task" && documentType !== "wiki" && documentType !== "chat")
    ) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid write-tool payload" } } };
    }
    if (bodyProjectId !== identity.projectId || bodyOwnerUserId !== identity.actorUserId) {
      return { status: 403, body: { error: { code: "NO_USER_CONTEXT", message: "identity mismatch" } } };
    }
    const args = (typeof payload.args === "object" && payload.args !== null ? payload.args : {}) as Record<string, unknown>;
    const runId = typeof payload.runId === "string" && payload.runId.length > 0 ? payload.runId : undefined;
    return executeAssistantWriteTool(driver, {
      name,
      args,
      batchId,
      seq,
      projectId: identity.projectId,
      documentType,
      documentId,
      ownerUserId: identity.actorUserId,
      ...(runId !== undefined ? { runId } : {}),
    });
  }

  // Auto-mode write execution (D4): the DO's write tool maps straight to the
  // extracted apply path — no pending row, no suspend. Identity/project are
  // enforced exactly like the proposal route; the Worker executor owns the
  // domain switch and reports `{ ok, applied, result?, error?, partial? }`.
  if (method === "POST" && path === "/api/internal/assistant/write-execute") {
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0 || identity.actorUserId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const name = typeof payload.name === "string" ? payload.name : "";
    const bodyProjectId = typeof payload.projectId === "string" ? payload.projectId : "";
    const bodyOwnerUserId = typeof payload.ownerUserId === "string" ? payload.ownerUserId : "";
    if (name.length === 0 || bodyProjectId.length === 0 || bodyOwnerUserId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid write-execute payload" } } };
    }
    if (!isAssistantWriteTool(name)) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: `Unknown write tool: ${name}` } } };
    }
    if (bodyProjectId !== identity.projectId || bodyOwnerUserId !== identity.actorUserId) {
      return { status: 403, body: { error: { code: "NO_USER_CONTEXT", message: "identity mismatch" } } };
    }
    if (!input.deps?.executeWriteTool) {
      return { status: 502, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "Write execution not wired" } } };
    }
    const args = (typeof payload.args === "object" && payload.args !== null ? payload.args : {}) as Record<string, unknown>;
    const result = await input.deps.executeWriteTool({
      name,
      args,
      projectId: identity.projectId,
      ownerUserId: identity.actorUserId,
    });
    return { status: 200, body: result };
  }

  // One `assistant_call_logs` row per provider call (engine onEnd/onError).
  if (method === "POST" && path === "/api/internal/assistant/call-log") {
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const model = typeof payload.model === "string" ? payload.model : "";
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const status = typeof payload.status === "string" ? payload.status : "";
    if (model.length === 0 || !CALL_LOG_KINDS.has(kind) || !CALL_LOG_STATUSES.has(status)) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid call-log payload" } } };
    }
    const parsed: AssistantCallLogInput = {
      projectId: typeof payload.projectId === "string" ? payload.projectId : null,
      providerId: typeof payload.providerId === "string" ? payload.providerId : null,
      model,
      kind: kind as ProviderKind,
      status: status as AssistantCallLogStatus,
      errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
      usageIn: typeof payload.usageIn === "number" ? payload.usageIn : 0,
      usageOut: typeof payload.usageOut === "number" ? payload.usageOut : 0,
      cachedIn: typeof payload.cachedIn === "number" ? payload.cachedIn : 0,
      latencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : null,
      costCents: typeof payload.costCents === "number" ? payload.costCents : 0,
      estimated: payload.estimated === true,
    };
    try {
      return { status: 200, body: await Effect.runPromise(insertCallLog(driver, parsed)) };
    } catch (e) {
      return {
        status: 500,
        body: { error: { code: "ASSISTANT_UNAVAILABLE", message: e instanceof Error ? e.message : "call-log write failed" } },
      };
    }
  }

  // Terminal run status + (task runs) activity emission, same transaction.
  if (method === "POST" && path === "/api/internal/assistant/run-status") {
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const status = typeof payload.status === "string" ? payload.status : "";
    if (runId.length === 0 || (status !== "completed" && status !== "failed" && status !== "cancelled")) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid run-status payload" } } };
    }
    // `Effect.runPromise` wraps a typed failure in a `FiberFailure`, so the
    // tagged error must be inspected with `Effect.either` — an `instanceof`
    // catch here would never match `RowNotFound`.
    const outcome = await Effect.runPromise(
      Effect.either(
        transitionAssistantRun(driver, {
          runId,
          status,
          result: typeof payload.result === "string" || payload.result === null ? payload.result : undefined,
          error: typeof payload.error === "string" || payload.error === null ? payload.error : undefined,
        })
      )
    );
    if (outcome._tag === "Left") {
      if (outcome.left._tag === "RowNotFound") {
        return { status: 404, body: { error: { code: "ASSISTANT_TASK_NOT_FOUND", message: "Unknown run" } } };
      }
      const message = "message" in outcome.left ? outcome.left.message : "run-status write failed";
      return { status: 500, body: { error: { code: "ASSISTANT_UNAVAILABLE", message } } };
    }
    return { status: 200, body: outcome.right };
  }

  // ── Delegation run registry (ADR-0004 §3; H3) ──────────────────────────
  // The parent DO creates a run row at dispatch and reports transitions. The
  // signed identity supplies project/thread; the body never overrides it.
  if (method === "POST" && path === "/api/internal/assistant/run-create") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const kind = payload.kind;
    const goal = typeof payload.goal === "string" ? payload.goal : "";
    if ((kind !== "chat_run" && kind !== "document" && kind !== "schedule") || goal.trim() === "") {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid run-create payload" } } };
    }
    const threadKey =
      typeof payload.threadKey === "string" && payload.threadKey.length > 0 ? payload.threadKey : identity.threadKey;
    if (threadKey.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "run thread key is required" } } };
    }
    const outcome = await Effect.runPromise(
      Effect.either(
        createAssistantRun(driver, {
          projectId: identity.projectId,
          threadKey,
          kind: kind as AssistantRunKind,
          goal,
          ...(typeof payload.id === "string" && payload.id.length > 0 ? { id: payload.id } : {}),
          parentRunId: typeof payload.parentRunId === "string" ? payload.parentRunId : null,
          budgetMs: typeof payload.budgetMs === "number" && Number.isFinite(payload.budgetMs) ? payload.budgetMs : null,
          createdBy:
            typeof payload.createdBy === "string" && payload.createdBy.length > 0
              ? payload.createdBy
              : identity.actorUserId.length > 0
                ? identity.actorUserId
                : null,
        })
      )
    );
    if (outcome._tag === "Left") {
      return { status: 500, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "run-create failed" } } };
    }
    return { status: 200, body: { run: outcome.right } };
  }

  if (method === "POST" && path === "/api/internal/assistant/run-update") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const payload = (input.body ?? {}) as Record<string, unknown>;
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const status = payload.status;
    const validStatus =
      status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "cancelled";
    if (runId.length === 0 || !validStatus) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid run-update payload" } } };
    }
    const outcome = await Effect.runPromise(
      Effect.either(
        transitionAssistantRunRegistry(driver, {
          runId,
          projectId: identity.projectId,
          status: status as AssistantRunStatus,
          result: typeof payload.result === "string" || payload.result === null ? payload.result : undefined,
          error: typeof payload.error === "string" || payload.error === null ? payload.error : undefined,
          stepsUsed: typeof payload.stepsUsed === "number" ? payload.stepsUsed : undefined,
        })
      )
    );
    if (outcome._tag === "Left") {
      if (outcome.left._tag === "RowNotFound") {
        return { status: 404, body: { error: { code: "ASSISTANT_RUN_NOT_FOUND", message: "Unknown run" } } };
      }
      return { status: 500, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "run-update failed" } } };
    }
    return { status: 200, body: outcome.right };
  }

  if (method === "POST" && path === "/api/internal/assistant/run-counts") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const threadKey = identity.threadKey;
    const outcome = await Effect.runPromise(Effect.either(countActiveRuns(driver, identity.projectId, threadKey)));
    if (outcome._tag === "Left") {
      return { status: 500, body: { error: { code: "ASSISTANT_UNAVAILABLE", message: "run-counts failed" } } };
    }
    return { status: 200, body: outcome.right };
  }

  if (method === "GET" && path === "/api/internal/assistant/run") {
    const identity = input.identity;
    if (!identity || identity.projectId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "missing internal identity" } } };
    }
    const runId = input.query?.["id"] ?? "";
    if (runId.length === 0) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "run id is required" } } };
    }
    const outcome = await Effect.runPromise(Effect.either(getAssistantRun(driver, runId, identity.projectId)));
    if (outcome._tag === "Left") {
      return { status: 404, body: { error: { code: "ASSISTANT_RUN_NOT_FOUND", message: "Unknown run" } } };
    }
    return { status: 200, body: { run: outcome.right } };
  }

  if (method === "POST" && path === "/api/internal/assistant/mirror") {
    const payload = (input.body ?? {}) as Partial<MirrorThreadInput>;
    if (
      typeof payload.threadKey !== "string" ||
      typeof payload.projectId !== "string" ||
      !Array.isArray(payload.messages)
    ) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid mirror payload" } } };
    }
    const result = await Effect.runPromise(
      mirrorThread(driver, {
        threadKey: payload.threadKey,
        projectId: payload.projectId,
        messages: payload.messages,
        summary: typeof payload.summary === "string" ? payload.summary : null,
        summarizedCount: typeof payload.summarizedCount === "number" ? payload.summarizedCount : null,
        title: typeof payload.title === "string" ? payload.title : null,
      })
    );
    return { status: 200, body: result };
  }

  if (method === "GET" && path.startsWith("/api/internal/assistant/legacy/")) {
    const rawSegment = path.slice("/api/internal/assistant/legacy/".length);
    if (rawSegment.length === 0 || rawSegment.includes("/")) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    let threadKey: string;
    try {
      threadKey = decodeURIComponent(rawSegment);
    } catch {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    const parsed = parseThreadKey(threadKey);
    if (!parsed) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    const messages = await Effect.runPromise(readLegacyThread(driver, parsed.documentType, parsed.documentId));
    if (messages === null) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "No legacy transcript" } } };
    }
    return { status: 200, body: { messages } };
  }

  return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown internal assistant route" } } };
}
