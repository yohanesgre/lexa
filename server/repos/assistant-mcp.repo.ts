import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, batch, type BatchStmt, DbError, RowNotFound, ConstraintViolation } from "../db/db";

// Stored column domain — mirrors the 0009 CHECK, which still names 'stdio'
// because D1 cannot DROP COLUMN / rebuild the table safely. Migration 0010
// deletes every stored stdio row, so only 'http'/'sse' rows exist after it.
// Read types only: nothing writes 'stdio'.
export type McpTransportType = "http" | "sse" | "stdio";

// Application support: Lexa connects to REMOTE MCP servers only. The stdio
// branch is dead in storage (0010) and unreachable from the public surface —
// service validation rejects it with MCP_INVALID_TRANSPORT_CONFIG.
export type McpClientTransportType = "http" | "sse";

export const MCP_CLIENT_TRANSPORTS: readonly McpClientTransportType[] = ["http", "sse"];

export interface McpServerRow {
  id: string;
  label: string;
  transport_type: McpTransportType;
  url: string | null;
  command: string | null;
  args: string;
  secret_ref: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// The bridge read shape: a registry row plus whatever ciphertext row the LEFT
// JOIN found. Ciphertext lives in `assistant_mcp_secrets` and NEVER enters
// `McpServerRow`, so a bare `SELECT *` of the registry cannot surface a blob;
// the three columns below are all-or-nothing (any non-null means managed).
// `key_id` stays a plain string here — this is the storage boundary, and the
// slot vocabulary is validated where the blob is opened (server/assistant/
// mcp.ts), so an unknown slot is a connect-time failure, not a repo one.
export interface McpServerRowWithSecret extends McpServerRow {
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_key_id: string | null;
}

/** The blob columns of a managed secret, exactly as the secret table stores them. */
export interface McpSecretStorage {
  ciphertext: string;
  iv: string;
  keyId: string;
}

export interface ProjectMcpServerRow {
  project_id: string;
  server_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface McpServerPublic {
  id: string;
  label: string;
  transportType: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  hasSecret: boolean;
  secretSource: McpSecretSource;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Managed-only (maintainer decision 2026-09-28): a client either authenticates
// with an envelope-encrypted managed token, or it is deliberately secret-less.
// The legacy `reference` arm is gone; `row.secret_ref` is never a credential
// any more and is ignored on read (and cleared on every write).
export type McpSecretSource = "managed" | "none";

export interface ProjectMcpServerPublic {
  projectId: string;
  serverId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Write inputs are remote-only: the type is the last gate before a row lands in
// the table, so 'stdio' cannot be persisted even if a caller skips validation.
// `command` stays on the input for the historical column but is always null.
export interface CreateMcpServerInput {
  id: string;
  label: string;
  transportType: McpClientTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  enabled: boolean;
}

export interface UpdateMcpServerInput {
  label?: string;
  transportType?: McpClientTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  enabled?: boolean;
}

export function parseArgs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// Boundary mapper: the raw row never crosses the API. `secret_ref` is dropped
// entirely and replaced with hasSecret + secretSource — the legacy reference
// must never be serialized, logged, or echoed, and neither may the ciphertext.
// Managed-only: `hasSecret` is true exactly when a ciphertext row exists, and
// `row.secret_ref` is deliberately ignored (a stale value is not a credential).
export function toPublic(row: McpServerRowWithSecret): McpServerPublic {
  const managed = row.secret_ciphertext !== null;
  return {
    id: row.id,
    label: row.label,
    transportType: row.transport_type,
    url: row.url,
    command: row.command,
    args: parseArgs(row.args),
    hasSecret: managed,
    secretSource: managed ? "managed" : "none",
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function projectToPublic(row: ProjectMcpServerRow): ProjectMcpServerPublic {
  return {
    projectId: row.project_id,
    serverId: row.server_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AssistantMcpRepo extends Effect.Service<AssistantMcpRepo>()("Lexa/AssistantMcpRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    // Every read goes through this projection: the registry columns plus the
    // ciphertext row when one exists. A LEFT JOIN (never INNER) keeps a
    // secret-less client readable, and the alias names keep the blob out of a
    // bare `SELECT *` of assistant_mcp_servers.
    const SELECT_WITH_SECRET = `SELECT s.*, sec.ciphertext AS secret_ciphertext, sec.iv AS secret_iv, sec.key_id AS secret_key_id
       FROM assistant_mcp_servers s
       LEFT JOIN assistant_mcp_secrets sec ON sec.server_id = s.id`;

    return {
      list: (): Effect.Effect<McpServerRowWithSecret[], DbError> =>
        queryAll<McpServerRowWithSecret>(db, `${SELECT_WITH_SECRET} ORDER BY s.id ASC`),

      getById: (id: string): Effect.Effect<McpServerRowWithSecret, RowNotFound | DbError> =>
        queryFirst<McpServerRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE s.id = ?`, id),

      create: (input: CreateMcpServerInput): Effect.Effect<McpServerRowWithSecret, DbError | ConstraintViolation> =>
        run(
          db,
          `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          input.label,
          input.transportType,
          input.url,
          input.command,
          JSON.stringify(input.args),
          input.enabled ? 1 : 0
        ).pipe(
          Effect.flatMap(() => queryFirst<McpServerRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE s.id = ?`, input.id)),
          // The row was just inserted in this statement pair; a missing read is
          // a database fault, not a not-found the caller must handle.
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: `assistant_mcp_servers row '${input.id}' missing after insert` })))
        ),

      update: (id: string, patch: UpdateMcpServerInput): Effect.Effect<McpServerRowWithSecret, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
          if (patch.transportType !== undefined) { sets.push("transport_type = ?"); params.push(patch.transportType); }
          if (patch.url !== undefined) { sets.push("url = ?"); params.push(patch.url); }
          if (patch.command !== undefined) { sets.push("command = ?"); params.push(patch.command); }
          if (patch.args !== undefined) { sets.push("args = ?"); params.push(JSON.stringify(patch.args)); }
          if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
          if (sets.length === 0) {
            const current = yield* queryFirst<McpServerRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE s.id = ?`, id);
            return current;
          }
          // Managed-only cleanup: every write nulls the legacy `secret_ref`
          // unconditionally, so a stale reference can never survive an edit.
          // The column stays (D1 cannot drop it), but nothing reads or writes a
          // value into it any more.
          sets.push("secret_ref = NULL");
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE assistant_mcp_servers SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<McpServerRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE s.id = ?`, id);
        }),

      // Upsert the managed blob. `ON CONFLICT` keeps a re-save a single
      // statement pair, and the write always carries a non-null server_id: the
      // table's bare `TEXT PRIMARY KEY` is NULL-insertable in SQLite practice,
      // so the repo refuses to hand SQLite a NULL key (the caller passes the id
      // of a registry row it just read).
      putSecret: (id: string, secret: McpSecretStorage): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO assistant_mcp_secrets (server_id, ciphertext, iv, key_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(server_id) DO UPDATE SET
             ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
             updated_at = datetime('now')`,
          id,
          secret.ciphertext,
          secret.iv,
          secret.keyId
        ).pipe(Effect.asVoid),

      // Pure row delete — no crypto, so it works with no master key configured
      // (the clear affordance must never depend on a key being present).
      deleteSecret: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM assistant_mcp_secrets WHERE server_id = ?`, id).pipe(Effect.asVoid),

      remove: (id: string): Effect.Effect<void, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          // Migration 0011's ON DELETE CASCADE fires under the Workers/D1
          // runner, but the Bun runner executes with PRAGMA foreign_keys = OFF
          // (server/db/migrate.ts), where it never does — so the child row is
          // deleted explicitly instead of stranding ciphertext whose key_id no
          // operator can read. Child first, then the not-found check.
          yield* run(db, `DELETE FROM assistant_mcp_secrets WHERE server_id = ?`, id);
          const changes = yield* run(db, `DELETE FROM assistant_mcp_servers WHERE id = ?`, id);
          if (changes === 0) return yield* Effect.fail(new RowNotFound({ table: "assistant_mcp_servers" }));
        }),

      listForProject: (projectId: string): Effect.Effect<ProjectMcpServerRow[], DbError> =>
        queryAll<ProjectMcpServerRow>(
          db,
          `SELECT * FROM assistant_mcp_project_servers WHERE project_id = ? ORDER BY server_id ASC`,
          projectId
        ),

      // Replace-set: drop the project's rows and re-insert the given set in one
      // atomic batch. JS de-dupe keeps a duplicate serverId from tripping the
      // composite PK mid-batch (which would roll the whole replace back).
      setProjectServers: (
        projectId: string,
        entries: Array<{ serverId: string; enabled: boolean }>
      ): Effect.Effect<void, ConstraintViolation | DbError> => {
        const seen = new Set<string>();
        const stmts: BatchStmt[] = [
          { sql: `DELETE FROM assistant_mcp_project_servers WHERE project_id = ?`, params: [projectId] },
        ];
        for (const entry of entries) {
          if (seen.has(entry.serverId)) continue;
          seen.add(entry.serverId);
          stmts.push({
            sql: `INSERT INTO assistant_mcp_project_servers (project_id, server_id, enabled) VALUES (?, ?, ?)`,
            params: [projectId, entry.serverId, entry.enabled ? 1 : 0],
          });
        }
        return batch(db, stmts);
      },
    };
  }),
}) {}
