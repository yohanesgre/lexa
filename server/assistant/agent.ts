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
import { stepCountIs, type StopCondition, type ToolSet, type UIMessage } from "ai";
import type { Connection, ConnectionContext } from "agents";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  INTERNAL_AUTH_HEADER,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";
import { fetchLegacyTranscript, mirrorTranscript, resolveProviderConfigs, resolveHarnessContext, recordCallLog, transitionRun, callReadTool, proposeWrite, callWriteExecute, type AssistantInternalDeps } from "./agent-runtime";
import { AssistantTurnError, runAssistantTurn, type AssistantTurnDeps } from "./engine";
import { buildReadTools, buildWriteTools, createAssistantWriteBudget, createBudgetedWriteExecutor, shouldSuspendOnProposal, type AssistantToolTransport } from "./tools-ai";
import { MAX_WRITES_PER_TURN } from "./write-tool-names";
import { resolveAssistantToolPermissionMode, resolveThreadToolPermissionMode, type AssistantToolPermissionMode } from "../../shared/assistant";
import { buildSystemPrompts, CHAT_IDENTITY, IDENTITY, systemPromptText } from "./prompt";
import { lastUserText } from "./context";
import { MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS } from "./tool-caps";
import { withApprovalCarriers } from "./approval-carrier";

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
  // Optional self service binding back to the Worker that hosts the internal
  // assistant routes (ADR-0003 §B.2/R7). When absent the DO falls back to a
  // global fetch against the public origin (the ADR alternative).
  ASSISTANT_SERVICE?: Fetcher | undefined;
}

type ThreadMetaRow = {
  thread_key: string;
  project_id: string;
  owner_user_id: string | null;
  imported_from_d1: number;
  created_at: string;
  permission_mode: string | null;
}

const THREAD_META_DDL = `CREATE TABLE IF NOT EXISTS thread_meta (
  thread_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT,
  imported_from_d1 INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    // Pre-existing DOs created `thread_meta` without `permission_mode`; a
    // `CREATE TABLE IF NOT EXISTS` cannot add a column. Guarded PRAGMA +
    // ALTER gives those stores the sticky mode column (D2/E). The ALTER has a
    // constant default, so existing rows become 'ask'.
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(thread_meta)")
      .toArray();
    if (!columns.some((column) => column.name === "permission_mode")) {
      this.ctx.storage.sql.exec("ALTER TABLE thread_meta ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'");
    }
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
    const masterKey = this.env.LXK_SECRETS_MASTER_KEY;
    if (!masterKey) return null;
    const origin = await this.ctx.storage.get<string>(INTERNAL_ORIGIN_KEY);
    const identity = await this.ctx.storage.get<InternalAuthIdentity>(INTERNAL_IDENTITY_KEY);
    if (!origin || !identity) return null;
    const service = this.env.ASSISTANT_SERVICE;
    return {
      origin,
      identity,
      masterKey,
      ...(service
        ? { fetchImpl: (input: string, init?: RequestInit) => service.fetch(input, init as never) as unknown as Promise<Response> }
        : {}),
    };
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

  // Send `null` for summary/count/title until the P3 engine supplies real
  // values: the mirror SQL COALESCEs, so `null` means "keep the D1 column".
  // A literal 0 would clobber a seeded `summarized_count` on every persist.
  private async mirrorCurrent(): Promise<boolean> {
    const deps = await this.loadInternalDeps();
    if (!deps) return false;
    const ok = await mirrorTranscript(deps, { messages: this.messages, summary: null, summarizedCount: null, title: null });
    if (!ok) {
      console.warn(`[Assistant] mirror failed for ${this.ctx.id.name ?? "unknown"} (will re-mirror on next step)`);
    }
    return ok;
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
    await super.persistMessages(withCarriers, excludeBroadcastIds, options);
    this.messages = withCarriers;
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
      resolveProviderConfigs: (projectId) => resolveProviderConfigs(deps, projectId),
      recordCallLog: async (input) => {
        await recordCallLog(deps, input);
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
    const transport: AssistantToolTransport = {
      read: (name, args) => callReadTool(deps, name, args),
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
    // signed identity wins; `userText` is only what the model will see.
    const harness = await resolveHarnessContext(deps, {
      threadKey,
      userText: lastUserText(this.messages),
      mode: "turn",
    });
    const availableRead = new Set(harness?.readTools ?? CORE_READ_TOOLS);
    const enabledWrite = harness?.writeTools ?? [];
    const tools: ToolSet = {
      ...buildReadTools({ transport, available: availableRead }),
      ...buildWriteTools({ transport, enabled: enabledWrite, mode: permissionMode }),
    };
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
        threadSummary: harness?.threadSummary ?? null,
      })
    );
    try {
      return await runAssistantTurn(turnDeps, {
        projectId: meta.project_id,
        threadKey,
        sessionId,
        messages: this.messages,
        tools,
        system,
        stopWhen,
        runId,
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
    } catch (e) {
      const turnError = e instanceof AssistantTurnError ? e : null;
      if (turnError) return assistantErrorResponse(turnError.status, turnError.code, turnError.message);
      console.error("[Assistant] engine turn failed:", e instanceof Error ? e.message : String(e));
      return assistantErrorResponse(502, "ASSISTANT_GENERATION_FAILED", "Assistant generation failed");
    }
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
    // summary/summarizedCount stay null until the P3 engine tracks them on the
    // DO; the REST read prefers a non-null DO value over the D1 mirror. The
    // sticky permission mode hydrates the composer picker (D2/D5); a
    // pre-column/uninitialized store falls back to "ask".
    this.ensureThreadMetaTable();
    const meta = this.readThreadMeta(this.ctx.id.name ?? "");
    return {
      messages: this.messages,
      summary: null,
      summarizedCount: null,
      permissionMode: resolveAssistantToolPermissionMode(undefined, meta?.permission_mode),
    };
  }

  async resumeBatch(_batchId: string | null): Promise<{ ok: true }> {
    return { ok: true };
  }

  async enqueueRun(_projectId: string, taskId: string): Promise<{ ok: true }> {
    // The run id keys the terminal status transition the engine reports back
    // through `/api/internal/assistant/run-status`. Full background run start
    // (`runFiber`) lands with the tools/run-control pass.
    try {
      await this.ctx.storage.put(RUN_ID_KEY, taskId);
    } catch (e) {
      console.warn("[Assistant] failed to persist run id:", e instanceof Error ? e.message : String(e));
    }
    return { ok: true };
  }

  async abortRun(_taskId: string): Promise<{ ok: true }> {
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
