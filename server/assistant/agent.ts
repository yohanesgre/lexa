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
import type { UIMessage } from "ai";
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
import { fetchLegacyTranscript, mirrorTranscript, type AssistantInternalDeps } from "./agent-runtime";

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
}

const THREAD_META_DDL = `CREATE TABLE IF NOT EXISTS thread_meta (
  thread_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT,
  imported_from_d1 INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const INTERNAL_ORIGIN_KEY = "internalOrigin";
const INTERNAL_IDENTITY_KEY = "internalIdentity";

function documentTypeOf(threadKey: string): "chat" | "task" | "wiki" | null {
  const separator = threadKey.indexOf(":");
  if (separator <= 0) return null;
  const documentType = threadKey.slice(0, separator);
  return documentType === "chat" || documentType === "task" || documentType === "wiki" ? documentType : null;
}

export class LexaAssistantAgent extends AIChatAgent<LexaAssistantEnv> {
  // TS 7's preview compiler does not surface the protected `ctx`/`env` fields
  // inherited through `DurableObject` (an `export =` module); re-declaring them
  // here restores the access the base class provides at runtime.
  declare protected ctx: DurableObjectState<Record<string, unknown>>;
  declare protected env: LexaAssistantEnv;

  private ensureThreadMetaTable(): void {
    this.ctx.storage.sql.exec(THREAD_META_DDL);
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
    await super.persistMessages(messages, excludeBroadcastIds, options);
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

  // P1 echo/no-op turn: no provider calls, no tools. Returns the last user text
  // so the transport (plain-text reply path) has something to stream. The real
  // engine arrives in P3.
  override async onChatMessage(): Promise<Response | undefined> {
    this.ensureThreadMetaTable();
    const lastUser = [...this.messages].reverse().find((message) => message.role === "user");
    const text = (lastUser?.parts ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part)
      .map((part) => part.text)
      .join("");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // ─── Thread lifecycle RPC surface (ADR-0003 §B.4) ──────────────────────
  // The DO canonical read + the mutations the Worker REST paths forward to.
  // Engine-backed run control (`resumeBatch`/`enqueueRun`/`abortRun`) is a
  // stub until P3; the invariants (one DO per thread, DO is canonical) hold now.

  async getTranscript(): Promise<{ messages: UIMessage[]; summary: string | null; summarizedCount: number | null }> {
    // summary/summarizedCount stay null until the P3 engine tracks them on the
    // DO; the REST read prefers a non-null DO value over the D1 mirror.
    return { messages: this.messages, summary: null, summarizedCount: null };
  }

  async resumeBatch(_batchId: string | null): Promise<{ ok: true }> {
    return { ok: true };
  }

  async enqueueRun(_projectId: string, _taskId: string): Promise<{ ok: true }> {
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
