// LexaAssistantAgent — the assistant Durable Object (ADR-0003 §B.1).
// One instance per conversation thread (`chat:<id>` | `task:<id>` |
// `wiki:<id>`), bound as `ASSISTANT_AGENT` and exported from
// `server/workers-entry.ts`.
//
// P1 groundwork only: the class skeleton, DO SQLite `thread_meta` pinning, the
// DO-side HMAC gate, and a no-provider echo turn. Engine, tools, mirroring, and
// legacy import are P2/P3 (out of scope here).

import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection, ConnectionContext } from "agents";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
  INTERNAL_AUTH_HEADER,
  verifyInternalAuth,
  type InternalAuthIdentity,
} from "./internal-auth";

export interface LexaAssistantEnv {
  LXK_SECRETS_MASTER_KEY?: string | undefined;
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

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const identity = await this.verifyConnection(context);
    if (!identity) {
      connection.close(1008, "invalid internal authentication");
      return;
    }
    await super.onConnect(connection, context);
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
}
