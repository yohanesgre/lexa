// LexaAssistantAgent — the assistant Durable Object (ADR-0003 §B.1).
// One instance per conversation thread (`chat:<id>` | `task:<id>` |
// `wiki:<id>`), bound as `ASSISTANT_AGENT` and exported from
// `server/workers-entry.ts`.
//
// P2 adds the thread layer on top of P1's skeleton: DO-side `thread_meta`
// pinning, the HMAC gate, migrate-on-read import from the D1 mirror, per-step
// mirror write-back, the thread-lifecycle RPC surface, and the P1 echo turn.
// The real engine/tools arrive in P3.

import { AIChatAgent } from "@cloudflare/ai-chat";
import { stepCountIs, tool, type StopCondition, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import type { Connection, ConnectionContext } from "agents";
import type { Ai, DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  INTERNAL_AUTH_HEADER,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";
import { fetchLegacyTranscript, mirrorTranscript, resolveProviderConfigs, resolveHarnessContext, recordCallLog, recordProviderHealthRemote, transitionRun, callReadTool, proposeWrite, callWriteExecute, createRunRemote, updateRunRemote, getRunRemote, countRunsRemote, executeResumeBatchRemote, type AssistantInternalDeps } from "./agent-runtime";
import { AssistantTurnError, runAssistantTurn, type AssistantTurnDeps } from "./engine";
import { buildMcpToolSet, buildReadTools, buildWriteTools, createAssistantWriteBudget, createBudgetedWriteExecutor, shouldSuspendOnProposal, type AssistantToolTransport } from "./tools-ai";
import { MAX_WRITES_PER_TURN } from "./write-tool-names";
import { deriveChatTitle, resolveAssistantToolPermissionMode, resolveThreadToolPermissionMode, type AssistantToolPermissionMode } from "../../shared/assistant";
import { buildSystemPrompts, CHAT_IDENTITY, IDENTITY, systemPromptText } from "./prompt";
import { firstUserText, lastUserText } from "./context";
import { MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS } from "./tool-caps";
import { withApprovalCarriers } from "./approval-carrier";
import { pendingBatchIdsNewestFirst } from "./build-stream";
import { summaryWindow, summarizeTranscript } from "./summarize";
import { assistantTraceParams, tracedAI } from "./tracing";
import { LexaAssistantRunner } from "./runner";
import { abortDelegatedRun, dispatchRegisteredRun, isTerminalAgentToolStatus, runStatusForTerminal, spawnDelegatedRun, DEFAULT_RUN_BUDGET_MS, PROJECT_RUN_LIMIT, THREAD_RUN_LIMIT, type AgentToolTerminalStatus, type DelegationDeps, type RunDispatcher } from "./delegation";
import type { AssistantCallLogInput } from "../../shared/assistant";
import { attachWorkersAiBinding } from "./model-factory";

// Read tools available without per-project settings resolution (project data +
// attachments). The optional tools (web_search / get_skill / analyze_image /
// jev_assess) are gated by settings the DO does not load yet — adding them
// blindly would offer capabilities the Worker may reject. Wired in the next
// settings pass alongside the Worker read-tool executor.
const CORE_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  "fetch_url",
  "read_s3_file",
  "get_task",
  "search_tasks",
  "search_wiki",
  "read_wiki_page",
  "get_all_tasks",
  "get_all_wiki_pages",
  "get_board_structure",
]);

export interface LexaAssistantEnv {
  LXK_SECRETS_MASTER_KEY?: string | undefined;
  // Public worker origin. Used to reach the Worker internal routes for a run
  // dispatched without a connect (cron schedule ticks); the connect path
  // persists its own origin, which wins when present.
  LXK_PUBLIC_URL?: string | undefined;
  // Optional self service binding back to the Worker that hosts the internal
  // assistant routes (ADR-0003 §B.2/R7). When absent the DO falls back to a
  // global fetch against the public origin (the ADR alternative).
  ASSISTANT_SERVICE?: Fetcher | undefined;
  // H9: the Cloudflare AI binding, declared in wrangler.jsonc. A `workers_ai`
  // model in the resolved chain is built keyless through this binding; absent
  // (Bun flavor) the config resolution leaves such models unbuildable.
  AI?: Ai | undefined;
}

type ThreadMetaRow = {
  thread_key: string;
  project_id: string;
  owner_user_id: string | null;
  imported_from_d1: number;
  created_at: string;
  permission_mode: string | null;
  summary: string | null;
  summarized_count: number;
}

const THREAD_META_DDL = `CREATE TABLE IF NOT EXISTS thread_meta (
  thread_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT,
  imported_from_d1 INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  summary TEXT,
  summarized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

// LX-80: one reservation per approval batch so a retry, a double-click, or two
// tabs cannot re-execute the same approved writes. `INSERT OR IGNORE` is
// synchronous and atomic inside the DO's single input gate; a duplicate claim
// writes 0 rows and the caller no-ops.
const RESUME_CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS resume_claims (
  batch_id TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const INTERNAL_ORIGIN_KEY = "internalOrigin";
const INTERNAL_IDENTITY_KEY = "internalIdentity";
const RUN_ID_KEY = "assistantRunId";

// Recovery budgets from ADR-0003 §B.5 (maxAttempts 10, noProgressTimeoutMs
// 300_000, maxRecoveryWork 1000, maxOomRetries 3, keep recovering). Assigned as
// a class field — the SDK reads it on wake before `onStart()` runs.
const ASSISTANT_CHAT_RECOVERY = {
  maxAttempts: 10,
  noProgressTimeoutMs: 300_000,
  maxRecoveryWork: 1000,
  maxOomRetries: 3,
  terminalMessage: "Assistant generation failed after repeated interruptions",
  shouldKeepRecovering: () => true,
} as const;

function documentTypeOf(threadKey: string): "chat" | "task" | "wiki" | null {
  const separator = threadKey.indexOf(":");
  if (separator <= 0) return null;
  const documentType = threadKey.slice(0, separator);
  return documentType === "chat" || documentType === "task" || documentType === "wiki" ? documentType : null;
}

function assistantErrorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Build the signed internal deps for one DO operation. `storedOrigin` (persisted
 * at connect) wins; a cron-dispatched `enqueueRun` never connected, so it falls
 * back to `env.LXK_PUBLIC_URL`. Reuses the same HMAC identity/origin derivation
 * the connect path persists — no `onConnect` requirement.
 */
export function buildInternalDepsForRun(
  env: LexaAssistantEnv,
  identity: InternalAuthIdentity | null,
  storedOrigin?: string
): AssistantInternalDeps | null {
  const masterKey = env.LXK_SECRETS_MASTER_KEY;
  if (!masterKey || !identity) return null;
  // A reachable origin: the connect-persisted one wins; a cron-dispatched
  // `enqueueRun` never connected and a default workers.dev install has no
  // `LXK_PUBLIC_URL`, so fall back to the fixed origin the service binding
  // proves (the runner uses the same constant — `runner.ts`). Without the
  // binding there is no origin and the caller degrades (logged, not silent).
  const service = env.ASSISTANT_SERVICE;
  const origin = storedOrigin ?? env.LXK_PUBLIC_URL ?? (service ? "https://assistant.internal" : undefined);
  if (!origin) return null;
  return {
    origin,
    identity,
    masterKey,
    ...(service
      ? { fetchImpl: (input: string, init?: RequestInit) => service.fetch(input, init as never) as unknown as Promise<Response> }
      : {}),
  };
}

export class LexaAssistantAgent extends AIChatAgent<LexaAssistantEnv> {
  // TS 7's preview compiler does not surface the protected `ctx`/`env` fields
  // inherited through `DurableObject` (an `export =` module); re-declaring them
  // here restores the access the base class provides at runtime.
  declare protected ctx: DurableObjectState<Record<string, unknown>>;
  declare protected env: LexaAssistantEnv;

  // Durable chat recovery (ADR-0003 §B.5). The base class declares this field;
  // assigning it here (not in `onStart`) makes the budgets effective on wake.
  override chatRecovery = ASSISTANT_CHAT_RECOVERY;

  private async loadRunId(): Promise<string | null> {
    try {
      return (await this.ctx.storage.get<string>(RUN_ID_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  private ensureThreadMetaTable(): void {
    this.ctx.storage.sql.exec(THREAD_META_DDL);
    // Pre-existing DOs created `thread_meta` without the later columns; a
    // `CREATE TABLE IF NOT EXISTS` cannot add a column. Guarded PRAGMA + ALTER
    // gives those stores the sticky mode (D2/E) and the compaction state (H2).
    // Every ALTER has a constant default, so existing rows get safe values.
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(thread_meta)")
      .toArray();
    if (!columns.some((column) => column.name === "permission_mode")) {
      this.ctx.storage.sql.exec("ALTER TABLE thread_meta ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'");
    }
    if (!columns.some((column) => column.name === "summary")) {
      this.ctx.storage.sql.exec("ALTER TABLE thread_meta ADD COLUMN summary TEXT");
    }
    if (!columns.some((column) => column.name === "summarized_count")) {
      this.ctx.storage.sql.exec("ALTER TABLE thread_meta ADD COLUMN summarized_count INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureResumeClaimsTable(): void {
    this.ctx.storage.sql.exec(RESUME_CLAIMS_DDL);
  }

  // Atomic claim: true when this call inserted the reservation, false when a
  // prior claim (retry, second tab, reload) already owns the batch.
  private claimResumeBatch(batchId: string): boolean {
    const cursor = this.ctx.storage.sql.exec("INSERT OR IGNORE INTO resume_claims (batch_id) VALUES (?)", batchId);
    return cursor.rowsWritten > 0;
  }

  // A batch that turned out not to be executable (still pending / no rows) is
  // released so a later attempt can resume it once it is fully decided.
  private releaseResumeBatch(batchId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM resume_claims WHERE batch_id = ?", batchId);
  }

  private readThreadMeta(threadKey: string): ThreadMetaRow | null {
    const rows = this.ctx.storage.sql
      .exec<ThreadMetaRow>("SELECT * FROM thread_meta WHERE thread_key = ?", threadKey)
      .toArray();
    return rows[0] ?? null;
  }

  // First connect pins the project + owner; later connects must match. Chat is
  // owner-scoped; task/wiki are project-scoped (any project member — the Worker
  // gate re-checks authorization, this is defense-in-depth).
  private pinThreadMeta(threadKey: string, projectId: string, ownerUserId: string | null): boolean {
    const existing = this.readThreadMeta(threadKey);
    if (existing) {
      if (existing.project_id !== projectId) return false;
      if (existing.owner_user_id !== null && existing.owner_user_id !== ownerUserId) return false;
      return true;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO thread_meta (thread_key, project_id, owner_user_id) VALUES (?, ?, ?)",
      threadKey,
      projectId,
      ownerUserId
    );
    return true;
  }

  private markImported(threadKey: string): void {
    this.ctx.storage.sql.exec("UPDATE thread_meta SET imported_from_d1 = 1 WHERE thread_key = ?", threadKey);
  }

  private async verifyConnection(context: ConnectionContext): Promise<InternalAuthIdentity | null> {
    const masterKey = this.env.LXK_SECRETS_MASTER_KEY;
    if (!masterKey) return null;
    const headers = context.request.headers;
    const identity: InternalAuthIdentity = {
      actorUserId: headers.get(INTERNAL_AUTH_ACTOR_HEADER) ?? "",
      projectId: headers.get(INTERNAL_AUTH_PROJECT_HEADER) ?? "",
      threadKey: headers.get(INTERNAL_AUTH_THREAD_HEADER) ?? "",
    };
    // The signed identity must address this instance: the Worker pins the DO
    // name to the threadKey, so a verified signature for another thread is a
    // routing bug at best and an impersonation at worst.
    if (identity.threadKey.length === 0 || identity.threadKey !== (this.ctx.id.name ?? "")) return null;
    if (identity.projectId.length === 0 || identity.actorUserId.length === 0) return null;
    if (!(await verifyInternalAuth(masterKey, headers.get(INTERNAL_AUTH_HEADER), identity))) return null;
    this.ensureThreadMetaTable();
    const documentType = documentTypeOf(identity.threadKey);
    if (!documentType) return null;
    const ownerUserId = documentType === "chat" ? identity.actorUserId : null;
    if (!this.pinThreadMeta(identity.threadKey, identity.projectId, ownerUserId)) return null;
    return identity;
  }

  // Reconstruct the deps needed to call the Worker internal routes after a cold
  // wake. Origin + identity are persisted at connect, so a mirror triggered by
  // a later persist still authenticates.
  private async loadInternalDeps(): Promise<AssistantInternalDeps | null> {
    const origin = await this.ctx.storage.get<string>(INTERNAL_ORIGIN_KEY);
    const identity = await this.ctx.storage.get<InternalAuthIdentity>(INTERNAL_IDENTITY_KEY);
    return buildInternalDepsForRun(this.env, identity ?? null, origin ?? undefined);
  }

  // Persist the reachable origin + signed identity when absent. `onConnect`
  // writes them for an interactive thread; a cron-dispatched schedule run never
  // connects, so `enqueueRun` writes the same keys before dispatching so the
  // detached completion hook (`onRunFinished`) can rebuild deps after a cold
  // wake. An existing connect value wins — never overwrite it.
  private async persistInternalContext(origin: string, identity: InternalAuthIdentity): Promise<void> {
    try {
      if ((await this.ctx.storage.get<string>(INTERNAL_ORIGIN_KEY)) == null) {
        await this.ctx.storage.put(INTERNAL_ORIGIN_KEY, origin);
      }
      if ((await this.ctx.storage.get<InternalAuthIdentity>(INTERNAL_IDENTITY_KEY)) == null) {
        await this.ctx.storage.put(INTERNAL_IDENTITY_KEY, identity);
      }
    } catch (e) {
      console.warn("[Assistant] failed to persist internal context:", e instanceof Error ? e.message : String(e));
    }
  }

  // Migrate-on-read (ADR-0003 §B.3): the first activation of a thread whose DO
  // store is empty imports the legacy D1 transcript once. Returns false when the
  // Worker was unreachable after the retry-once policy (caller maps to
  // ASSISTANT_UNAVAILABLE).
  private async ensureImported(): Promise<boolean> {
    this.ensureThreadMetaTable();
    const threadKey = this.ctx.id.name ?? "";
    const meta = this.readThreadMeta(threadKey);
    if (!meta || meta.imported_from_d1 === 1) return true;
    if (this.messages.length > 0) {
      this.markImported(threadKey);
      return true;
    }
    const deps = await this.loadInternalDeps();
    if (!deps) {
      // Internal deps unavailable (no origin/identity persisted): do NOT mark
      // imported — a later connect must retry, never forfeit legacy history.
      return false;
    }
    const converted = await fetchLegacyTranscript(deps);
    if (converted && converted.length > 0) {
      // Bypass the mirror override: this transcript came FROM D1.
      await super.persistMessages(converted);
      this.messages = converted;
    }
    this.markImported(threadKey);
    return true;
  }

  // Persist the DO's canonical compaction state to the D1 mirror with real
  // values (H2). A `null` summary/count means "no engine value yet" — the SQL
  // COALESCEs, so a pre-existing D1 row keeps its seeded columns until the DO
  // actually summarizes.
  //
  // Title: the DO owns no title column, so it derives one from the opening user
  // turn and sends it every mirror; the Worker's `COALESCE(assistant_threads.title,
  // ?)` backfills only while the D1 title is still NULL (ADR-0003 §B.3), so a
  // rename or an existing title is never overwritten. No user message → null.
  private async mirrorCurrent(): Promise<boolean> {
    const deps = await this.loadInternalDeps();
    if (!deps) return false;
    const meta = this.readThreadMeta(this.ctx.id.name ?? "");
    const hasSummary = meta?.summary != null && meta.summary.trim() !== "";
    const derivedTitle = deriveChatTitle(firstUserText(this.messages));
    const ok = await mirrorTranscript(deps, {
      messages: this.messages,
      summary: hasSummary ? meta!.summary : null,
      summarizedCount: hasSummary ? meta!.summarized_count : null,
      title: derivedTitle.length > 0 ? derivedTitle : null,
    });
    if (!ok) {
      console.warn(`[Assistant] mirror failed for ${this.ctx.id.name ?? "unknown"} (will re-mirror on next step)`);
    }
    return ok;
  }

  // H2 compaction: when the transcript crosses 40 messages / 64 KiB, condense
  // everything outside the last-8 window (incrementally since the last summary)
  // with one cheap `generateText`, then persist the summary + count on the DO.
  // Fully fail-open: no deps, no provider binding, or a provider failure simply
  // skips this event and the next persist retries. Idempotent for an unchanged
  // transcript ("threshold once"); survives wake because the state lives in
  // `thread_meta`, not in memory.
  private async maybeSummarize(): Promise<void> {
    const threadKey = this.ctx.id.name ?? "";
    const meta = this.readThreadMeta(threadKey);
    if (!meta) return;
    const window = summaryWindow(this.messages, meta.summarized_count);
    if (!window) return;
    const deps = await this.loadInternalDeps();
    if (!deps) return;
    try {
      const configs = await resolveProviderConfigs(deps, meta.project_id);
      if (!configs || configs.length === 0) return;
      const summary = await summarizeTranscript(window.older, meta.summary, configs, {
        generateTextImpl: tracedAI.generateText,
        trace: assistantTraceParams({
          agentId: this.ctx.id.toString(),
          conversationId: threadKey,
          purpose: "summary",
        }),
      });
      if (summary === null) return;
      this.ctx.storage.sql.exec(
        "UPDATE thread_meta SET summary = ?, summarized_count = ? WHERE thread_key = ?",
        summary,
        window.summarizedCount,
        threadKey
      );
    } catch (e) {
      console.warn("[Assistant] summary failed (skipping):", e instanceof Error ? e.message : String(e));
    }
  }

  override async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds?: string[],
    options?: { _deleteStaleRows?: boolean }
  ): Promise<void> {
    // W7b/WS1: append the `data-assistant-approval` carrier to any assistant
    // message holding successful write proposals, so the DO canonical store and
    // the D1 mirror both carry the approvals marker (idempotent).
    const withCarriers = withApprovalCarriers(messages);
    // Do NOT hand-patch `this.messages` from the argument: the SDK persists an
    // incoming array that can be run-scoped (only the current run's messages,
    // e.g. the programmatic `saveMessages` write and the client chat-request
    // body), and the base class mirrors the merged transcript into
    // `this.messages` from the Sessions change feed before `super` resolves.
    // Assigning the argument here shrank the DO-canonical read (`getTranscript`)
    // to the current run and made the terminal REST refetch erase earlier turns
    // (A9). The change feed is the sole writer of the in-memory cache; the
    // stored transcript was already correct, so delete/reset stays authoritative.
    await super.persistMessages(withCarriers, excludeBroadcastIds, options);
    // Compact first, then mirror the freshened summary/count to D1.
    await this.maybeSummarize();
    await this.mirrorCurrent();
  }

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const identity = await this.verifyConnection(context);
    if (!identity) {
      connection.close(1008, "invalid internal authentication");
      return;
    }
    try {
      await this.ctx.storage.put(INTERNAL_ORIGIN_KEY, new URL(context.request.url).origin);
      await this.ctx.storage.put(INTERNAL_IDENTITY_KEY, identity);
    } catch (e) {
      console.warn("[Assistant] failed to persist internal context:", e instanceof Error ? e.message : String(e));
    }
    await super.onConnect(connection, context);
    try {
      if (!(await this.ensureImported())) {
        connection.close(1011, "ASSISTANT_UNAVAILABLE");
      }
    } catch (e) {
      console.error("[Assistant] legacy import failed:", e instanceof Error ? e.message : String(e));
      connection.close(1011, "ASSISTANT_UNAVAILABLE");
    }
  }

  // Real engine turn (ADR-0003 §B.5/§C): resolve the project's provider chain
  // (decrypted Worker-side, never persisted here), stream the model through the
  // AI SDK with the built-in `x-opencode-session` header, and let the engine
  // record the call log + terminal run status via the internal routes.
  override async onChatMessage(
    _onFinish?: unknown,
    options?: { abortSignal?: AbortSignal | undefined; body?: Record<string, unknown> | undefined } | undefined
  ): Promise<Response | undefined> {
    this.ensureThreadMetaTable();
    const threadKey = this.ctx.id.name ?? "";
    const meta = this.readThreadMeta(threadKey);
    const deps = await this.loadInternalDeps();
    if (!meta || !deps) {
      return assistantErrorResponse(502, "ASSISTANT_UNAVAILABLE", "Assistant not configured");
    }
    // Turn-start mode capture (D2/D6): the send envelope overrides the sticky
    // thread value; the captured mode is then persisted as the new sticky value
    // and held constant for the whole turn. A mid-turn change waits for the next
    // send (or resume run). D5: the picker is chat-only, so a task/wiki run
    // stays "ask" even if a crafted envelope carries a mode.
    const sessionId = threadKey.slice(threadKey.indexOf(":") + 1);
    const documentType = documentTypeOf(threadKey);
    const permissionMode: AssistantToolPermissionMode = resolveThreadToolPermissionMode(
      documentType,
      options?.body?.permissionMode,
      meta.permission_mode
    );
    try {
      this.ctx.storage.sql.exec("UPDATE thread_meta SET permission_mode = ? WHERE thread_key = ?", permissionMode, threadKey);
    } catch (e) {
      console.warn("[Assistant] failed to persist permission mode:", e instanceof Error ? e.message : String(e));
    }
    const runId = await this.loadRunId();
    const turnDeps: AssistantTurnDeps = {
      resolveProviderConfigs: async (projectId) =>
        attachWorkersAiBinding(await resolveProviderConfigs(deps, projectId), this.env.AI),
      recordCallLog: async (input) => {
        await recordCallLog(deps, input);
      },
      recordProviderHealth: async ({ providerId, ok }) => {
        await recordProviderHealthRemote(deps, { providerId, ok });
      },
      transitionRun: async (input) => {
        const ok = await transitionRun(deps, input);
        // Terminal transition landed: clear the run cursor so later turns on
        // this thread do not re-fire the same transition (which would be a
        // no-op anyway, but keeping the id around invites repeat attempts).
        if (ok) {
          try {
            await this.ctx.storage.delete(RUN_ID_KEY);
          } catch (e) {
            console.warn("[Assistant] failed to clear run id:", e instanceof Error ? e.message : String(e));
          }
        }
      },
    };

    // Tool transport (ADR-0003 §B.5): read tools execute in the Worker; write
    // tools are mode-dependent. Ask persists a pending row and returns
    // `proposed:true` (approval suspend); auto applies immediately through
    // `/write-execute`; deny never reaches here (the tool refuses locally).
    // A write batch is minted per turn.
    const batchId = crypto.randomUUID();
    let writeSeq = 0;
    // Per-turn auto-write budget (R5): the DO-side counter replicates the
    // pending-row cap the ask path gets for free. A bulk call is one slot.
    const writeBudget = createAssistantWriteBudget();
    // Resolved agent id for the read-tool executor (H1 nit); filled from the
    // harness bundle once it resolves (the tools only execute after that).
    let readAgentId: string | undefined;
    const transport: AssistantToolTransport = {
      read: (name, args) => callReadTool(deps, name, args, readAgentId),
      propose: (name, args) =>
        proposeWrite(deps, {
          name,
          args,
          batchId,
          seq: writeSeq++,
          projectId: meta.project_id,
          documentType: documentType ?? "chat",
          documentId: sessionId,
          ownerUserId: deps.identity.actorUserId,
          // Run attribution (ADR-0004 §3; plan line 140): a document run pins a
          // run id cursor, so its proposals carry it; a plain chat turn has none.
          ...(runId !== null ? { runId } : {}),
        }),
      execute: createBudgetedWriteExecutor(
        writeBudget,
        MAX_WRITES_PER_TURN,
        (name, args) =>
          callWriteExecute(deps, {
            name,
            args,
            projectId: meta.project_id,
            ownerUserId: deps.identity.actorUserId,
          })
      ),
    };
    // Per-turn harness context (ADR-0004 §1; H1): one Worker round trip carries
    // agent/skill/memory/doc/mention/repo/Jev/summary plus tool gating. The
    // signed identity wins; `userText` is only what the model will see. A
    // resume continuation (`resumeBatch`) passes `resumeBatchId`, switching the
    // Worker to `mode: "resume"` (Jev preflight skipped, R2).
    const turnMode: "turn" | "resume" = options?.body && "resumeBatchId" in options.body ? "resume" : "turn";
    // The DO resume continuation carries the Worker's executed-write note so the
    // model sees the approved results; appended to the provider input only,
    // never persisted as a transcript turn (the SSE path used the equivalent
    // `resumeResultsNote`).
    const resumeResultsNote =
      options?.body && typeof options.body.resumeResultsNote === "string" && options.body.resumeResultsNote.trim() !== ""
        ? options.body.resumeResultsNote
        : null;
    const harness = await resolveHarnessContext(deps, {
      threadKey,
      userText: lastUserText(this.messages),
      mode: turnMode,
    });
    const availableRead = new Set(harness?.readTools ?? CORE_READ_TOOLS);
    readAgentId = harness?.agent?.id;
    const enabledWrite = harness?.writeTools ?? [];
    const tools: ToolSet = {
      ...buildReadTools({ transport, available: availableRead }),
      ...buildMcpToolSet(harness?.mcpTools ?? [], transport),
      ...buildWriteTools({ transport, enabled: enabledWrite, mode: permissionMode }),
    };
    // Delegation tools (ADR-0004 §3; H3): offered only when the Worker reports
    // delegation enabled for this turn. The Worker reads the global
    // `assistant_delegation_enabled` setting, which defaults off (dark launch;
    // H5 flips it on).
    if (harness?.delegation.enabled && harness.delegation.maxConcurrentRuns > 0) {
      Object.assign(tools, this.buildDelegationTools(deps, meta.project_id, threadKey, permissionMode));
    }
    const toolRoundCap = documentType === "chat" ? MAX_CHAT_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
    const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(toolRoundCap)];
    // Suspend only in ask mode on a SUCCESSFUL write proposal
    // (`proposed === true`). Auto results carry no `proposed`; deny refuses
    // locally — neither may stop the turn (D3/D4). A failed proposal is a
    // recoverable tool error the model may retry; stopping on mere tool-call
    // presence would end the turn on that failure (reviewer MED).
    if (enabledWrite.length > 0) {
      stopWhen.push(({ steps }) =>
        shouldSuspendOnProposal(
          permissionMode,
          enabledWrite,
          steps.flatMap((step) => step.toolResults.map((result) => ({ toolName: result.toolName, output: result.output })))
        )
      );
    }
    const system = systemPromptText(
      buildSystemPrompts({
        identity: documentType === "chat" ? CHAT_IDENTITY : IDENTITY,
        memoryBlock: harness?.memoryBlock ?? null,
        agentMarkdown: harness?.agent?.instructions ?? null,
        skillMarkdowns: harness?.skillMarkdowns ?? [],
        skillCatalog: harness?.skillCatalog ?? null,
        repoContent: harness?.repoContent ?? [],
        docContext: harness?.docContext ?? "",
        mentionContext: harness?.mentionContext ?? "",
        writeTools: enabledWrite,
        advisory: harness?.advisory ?? null,
        // The DO's own compaction state is fresher than the mirrored D1 value
        // the Worker read for this turn; prefer it when present (H2).
        threadSummary:
          meta.summary != null && meta.summary.trim() !== ""
            ? { summary: meta.summary, summarizedCount: meta.summarized_count }
            : harness?.threadSummary ?? null,
      })
    );
    try {
      return await runAssistantTurn(turnDeps, {
        projectId: meta.project_id,
        threadKey,
        sessionId,
        messages:
          resumeResultsNote !== null
            ? [
                ...this.messages,
                {
                  id: `resume-results-${crypto.randomUUID()}`,
                  role: "user",
                  parts: [{ type: "text", text: resumeResultsNote }],
                },
              ]
            : this.messages,
        tools,
        system,
        stopWhen,
        runId,
        callLogPurpose: "turn",
        streamTextImpl: tracedAI.streamText,
        trace: assistantTraceParams({
          agentId: this.ctx.id.toString(),
          conversationId: threadKey,
          purpose: turnMode,
          ...(runId !== null ? { runId } : {}),
        }),
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
    } catch (e) {
      const turnError = e instanceof AssistantTurnError ? e : null;
      if (turnError) return assistantErrorResponse(turnError.status, turnError.code, turnError.message);
      console.error("[Assistant] engine turn failed:", e instanceof Error ? e.message : String(e));
      return assistantErrorResponse(502, "ASSISTANT_GENERATION_FAILED", "Assistant generation failed");
    }
  }

  // ─── Delegation (ADR-0004 §3; H3) ──────────────────────────────────────
  // The parent owns the SDK facet dispatch + the D1 run registry bridge. The
  // facet child reaches the Worker internal routes through the `relay*` methods
  // below (it has no HMAC identity of its own).

  private delegationDeps(deps: AssistantInternalDeps): DelegationDeps {
    const dispatcher: RunDispatcher = {
      dispatch: async (input) => {
        try {
          const result = await this.runAgentTool(LexaAssistantRunner, {
            runId: input.runId,
            input: {
              runId: input.runId,
              goal: input.goal,
              projectId: input.projectId,
              threadKey: input.threadKey,
              mode: input.mode,
              budgetMs: input.budgetMs,
              createdBy: deps.identity.actorUserId,
            },
            detached: { onFinish: "onRunFinished", maxBudgetMs: input.budgetMs },
          });
          return result.status === "error"
            ? { status: "error", error: result.error ?? "dispatch rejected" }
            : { status: "running" };
        } catch (e) {
          return { status: "error", error: e instanceof Error ? e.message : "dispatch failed" };
        }
      },
      cancel: async (runId) => {
        await this.cancelAgentTool(runId);
      },
    };
    return {
      dispatcher,
      createRun: async (input) =>
        createRunRemote(deps, {
          id: input.id,
          kind: "chat_run",
          goal: input.goal,
          threadKey: input.threadKey,
          budgetMs: input.budgetMs,
          createdBy: input.createdBy,
          // Caps ride the create so the registry INSERT is the atomic authority
          // (the DO's pre-read is only a fast path).
          maxActiveThread: THREAD_RUN_LIMIT,
          maxActiveProject: PROJECT_RUN_LIMIT,
        }),
      updateRun: async (input) =>
        updateRunRemote(deps, {
          runId: input.runId,
          status: input.status,
          result: input.result ?? null,
          error: input.error ?? null,
        }),
      getRun: async (runId) => getRunRemote(deps, runId),
      counts: async () => (await countRunsRemote(deps)) ?? { thread: 0, project: 0 },
    };
  }

  private buildDelegationTools(
    deps: AssistantInternalDeps,
    projectId: string,
    threadKey: string,
    mode: AssistantToolPermissionMode
  ): ToolSet {
    const runDeps = this.delegationDeps(deps);
    return {
      spawn_run: tool({
        description:
          "Spawn a background run that works on one goal independently and reports back later. Returns a run id; use check_run to poll status. Runs inherit this thread's write mode and are budget-capped.",
        inputSchema: z.object({
          goal: z.string().min(1).max(2000).describe("What the background run should accomplish"),
          budgetMs: z.number().int().positive().optional().describe("Optional wall-clock budget in ms"),
        }),
        execute: (args) =>
          spawnDelegatedRun(runDeps, {
            goal: args.goal,
            projectId,
            threadKey,
            mode,
            createdBy: deps.identity.actorUserId,
            ...(args.budgetMs !== undefined ? { budgetMs: args.budgetMs } : {}),
          }),
      }),
      check_run: tool({
        description: "Check the status and result of a background run by its run id.",
        inputSchema: z.object({ runId: z.string().min(1) }),
        execute: async ({ runId }) => {
          const row = await runDeps.getRun(runId);
          return row ?? { error: "run not found" };
        },
      }),
    };
  }

  // Durable completion hook for detached runs (referenced by method name in the
  // detached config). Idempotent: a repeated terminal delivery is a no-op in the
  // registry's conditional UPDATE.
  async onRunFinished(
    run: { runId: string },
    result: { status: AgentToolTerminalStatus; summary?: string; error?: string; reason?: string; childStillRunning?: boolean }
  ): Promise<void> {
    // `interrupted` is a SOFT seal (agents SDK) only while the child may still
    // run: the parent stopped waiting but the child may reach a real terminal
    // and fire this hook again with `completed`. Leave the registry row
    // `running` and emit no terminal card so the late real result supersedes;
    // the stale-run reconciliation tick fails a row whose child never returns.
    // `interrupted` with `childStillRunning === false` is HARD: the child is
    // gone, so land the `failed` transition immediately and emit no card.
    const hardInterrupt = result.status === "interrupted" && result.childStillRunning === false;
    if (result.status === "interrupted" && !hardInterrupt) return;
    const deps = await this.loadInternalDeps();
    if (!deps) return;
    let status: "completed" | "failed" | "cancelled";
    let error: string | null;
    if (hardInterrupt) {
      status = "failed";
      error = result.reason ?? result.error ?? "interrupted";
    } else {
      if (!isTerminalAgentToolStatus(result.status)) return;
      status = runStatusForTerminal(result.status);
      error = result.error ?? null;
    }
    await updateRunRemote(deps, {
      runId: run.runId,
      status,
      result: result.summary ?? null,
      error,
    });
    // A hard interrupt is reported through the registry only (no card), so it
    // never races a later real terminal's card.
    if (hardInterrupt) return;
    // Server-driven result card (ADR-0004 §3): append the completion to the
    // parent transcript WITHOUT triggering a model turn. Dedupe is per terminal
    // kind, so an earlier non-terminal/interrupted delivery can never block a
    // later real terminal's card.
    const messageId = `run-${run.runId}-${status}`;
    if (this.messages.some((m) => m.id === messageId)) return;
    const label =
      status === "completed"
        ? "Background run finished"
        : status === "cancelled"
          ? "Background run cancelled"
          : "Background run failed";
    const detail = (result.summary ?? result.error ?? "").trim();
    const message: UIMessage = {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text: detail === "" ? label : `${label}: ${detail}` }],
    };
    try {
      await this.persistMessages([...this.messages, message]);
    } catch (e) {
      console.warn("[Assistant] failed to append run completion:", e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Parent relay RPC (facet → parent) ─────────────────────────────────
  async relayProviderConfigs(projectId: string) {
    const deps = await this.loadInternalDeps();
    if (!deps) return null;
    return resolveProviderConfigs(deps, projectId);
  }

  async relayCallLog(input: AssistantCallLogInput): Promise<void> {
    const deps = await this.loadInternalDeps();
    if (deps) await recordCallLog(deps, input);
  }

  async relayRunUpdate(input: {
    runId: string;
    status: "running" | "completed" | "failed" | "cancelled";
    result?: string | null;
    error?: string | null;
  }): Promise<void> {
    const deps = await this.loadInternalDeps();
    if (deps) await updateRunRemote(deps, input);
  }

  // ─── Thread lifecycle RPC surface (ADR-0003 §B.4) ──────────────────────
  // The DO canonical read + the mutations the Worker REST paths forward to.
  // Engine-backed run control (`resumeBatch`/`enqueueRun`/`abortRun`) is a
  // stub until P3; the invariants (one DO per thread, DO is canonical) hold now.

  async getTranscript(): Promise<{
    messages: UIMessage[];
    summary: string | null;
    summarizedCount: number | null;
    permissionMode: AssistantToolPermissionMode;
  }> {
    // H2: the DO now owns the compaction state; the REST read prefers a
    // non-null DO value over the D1 mirror. `null` still means "no engine value
    // yet" (never a literal 0) so a seeded D1 count is not clobbered.
    this.ensureThreadMetaTable();
    const meta = this.readThreadMeta(this.ctx.id.name ?? "");
    const summary = meta?.summary != null && meta.summary.trim() !== "" ? meta.summary : null;
    return {
      messages: this.messages,
      summary,
      summarizedCount: summary !== null ? (meta?.summarized_count ?? null) : null,
      permissionMode: resolveAssistantToolPermissionMode(undefined, meta?.permission_mode),
    };
  }

  async resumeBatch(batchId: string | null): Promise<{ ok: true }> {
    // LX-79/80/82: the DO is the single resume owner. Walk every batch marker
    // in the transcript newest-first and CLAIM each in DO storage before doing
    // any work — a duplicate claim means this batch is already resumed, so the
    // call no-ops early (LX-80; survives reload/wake). Then ask the Worker to
    // execute the batch's decided rows exactly once. `pending` reports a batch
    // that is not fully decided: release its claim and try the next older one,
    // so an older fully-decided batch resumes instead of being stranded (LX-82).
    // `missing` (no rows for this thread/owner) is likewise released and
    // skipped. `unavailable` is a transport/HTTP failure: the writes MAY have
    // applied, so KEEP the claim and never retry. On `executed`, keep the claim
    // and run exactly ONE continuation, injecting the Worker's results note so
    // the model does not re-propose the writes.
    this.ensureResumeClaimsTable();
    const deps = await this.loadInternalDeps();
    if (!deps) return { ok: true };
    const scanned = pendingBatchIdsNewestFirst(this.messages);
    const batches = batchId !== null && batchId.length > 0 && !scanned.includes(batchId) ? [batchId, ...scanned] : scanned;
    for (const id of batches) {
      if (!this.claimResumeBatch(id)) return { ok: true };
      const outcome = await executeResumeBatchRemote(deps, id);
      if (outcome.kind === "pending" || outcome.kind === "missing") {
        this.releaseResumeBatch(id);
        continue;
      }
      if (outcome.kind === "unavailable") return { ok: true };
      try {
        await this.continueLastTurn({
          resumeBatchId: id,
          ...(outcome.note.trim() !== "" ? { resumeResultsNote: outcome.note } : {}),
        });
      } catch (e) {
        console.warn("[Assistant] resumeBatch continuation failed:", e instanceof Error ? e.message : String(e));
      }
      return { ok: true };
    }
    return { ok: true };
  }

  async enqueueRun(input: {
    projectId: string;
    runId: string;
    actorUserId: string;
    /**
     * Explicit routing hint. `"schedule"` (set by the cron tick, which owns the
     * registry row's kind) never takes the document fallback below; omitted or
     * `"document"` is the legacy document-run path. The kind is passed rather
     * than inferred so a null `getRunRemote` (not-found vs unreachable) cannot
     * misroute a schedule run into a document run.
     */
    kind?: "document" | "schedule";
  }): Promise<{ ok: true }> {
    // Identity-object entry point (ADR-0004 §4): a cron tick hands over the
    // run coordinates; the DO derives its own thread key from the instance name.
    const threadKey = this.ctx.id.name ?? "";
    const identity: InternalAuthIdentity = { actorUserId: input.actorUserId, projectId: input.projectId, threadKey };
    const storedOrigin = await this.ctx.storage.get<string>(INTERNAL_ORIGIN_KEY);
    const deps = buildInternalDepsForRun(this.env, identity, storedOrigin ?? undefined);
    if (input.kind === "schedule") {
      // Schedule dispatch has its own branch: a missing/unreachable registry
      // row must never pin a run-id cursor on a schedule thread (that cursor
      // belongs to document runs). Log rather than silently degrade.
      if (!deps) {
        console.warn(
          `[Assistant] schedule run ${input.runId} could not dispatch: internal deps unavailable (missing master key or origin)`
        );
        return { ok: true };
      }
      const run = await getRunRemote(deps, input.runId);
      if (!run || run.kind !== "schedule") {
        console.warn(
          `[Assistant] schedule run ${input.runId} not found in the registry; left queued for reconciliation`
        );
        return { ok: true };
      }
      // The registry row already exists (created by the schedule tick): drive
      // the detached facet and land the running/failed transition. No insert,
      // no cap check. Detached runs have no interactive approver → `auto`.
      // Persist origin/identity first so the detached completion hook can
      // rebuild deps without an interactive connect (fix 2).
      await this.persistInternalContext(deps.origin, identity);
      await dispatchRegisteredRun(this.delegationDeps(deps), {
        runId: run.id,
        goal: run.goal,
        projectId: run.projectId,
        threadKey: run.threadKey,
        mode: "auto",
        budgetMs: run.budgetMs ?? DEFAULT_RUN_BUDGET_MS,
      });
      return { ok: true };
    }
    // Document run: pin the run-id cursor the engine's terminal transition
    // uses. `assistant_tasks` remains the document source of truth — the DO
    // creates no registry row for a document run. Only document runs reach
    // here; a schedule run never writes this key.
    try {
      await this.ctx.storage.put(RUN_ID_KEY, input.runId);
    } catch (e) {
      console.warn("[Assistant] failed to persist run id:", e instanceof Error ? e.message : String(e));
    }
    return { ok: true };
  }

  async abortRun(taskId: string): Promise<{ ok: true }> {
    const deps = await this.loadInternalDeps();
    if (deps) {
      try {
        await this.cancelAgentTool(taskId);
      } catch (e) {
        console.warn("[Assistant] cancelAgentTool failed:", e instanceof Error ? e.message : String(e));
      }
      await updateRunRemote(deps, { runId: taskId, status: "cancelled" });
    }
    return { ok: true };
  }

  async destroyThread(): Promise<{ ok: true }> {
    // Framework destruction primitive (same as `RoutedAgents.delete`): drops
    // the framework tables + storage through the SDK's own teardown. Never
    // `ctx.storage.deleteAll()` — that removes `cf_agents_session_*` behind
    // the SDK's cached schema and bricks the next wake ("no such table").
    await this._cf_scheduleDestroy();
    this.messages = [];
    return { ok: true };
  }

  async resetThread(): Promise<{ ok: true }> {
    // Clear the transcript through the session store. `persistMessages([])`
    // reconciles against prior messages and would leave the rows in place
    // (they resurrect on hydrate); `clearMessages()` DELETEs them and dispatches
    // the `clear` change event that empties `this.messages`.
    await this.sessions.session().clearMessages();
    this.messages = [];
    return { ok: true };
  }
}
