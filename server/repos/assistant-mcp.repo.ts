import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/db";

export type McpTransportType = "http" | "sse" | "stdio";

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
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMcpServerPublic {
  projectId: string;
  serverId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerInput {
  id: string;
  label: string;
  transportType: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  secretRef: string | null;
  enabled: boolean;
}

export interface UpdateMcpServerInput {
  label?: string;
  transportType?: McpTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
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
// entirely and replaced with hasSecret — the secret reference must never be
// serialized, logged, or echoed.
export function toPublic(row: McpServerRow): McpServerPublic {
  return {
    id: row.id,
    label: row.label,
    transportType: row.transport_type,
    url: row.url,
    command: row.command,
    args: parseArgs(row.args),
    hasSecret: row.secret_ref !== null && row.secret_ref !== "",
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

    return {
      list: (): Effect.Effect<McpServerRow[], DbError> =>
        queryAll<McpServerRow>(db, `SELECT * FROM assistant_mcp_servers ORDER BY id ASC`),

      getById: (id: string): Effect.Effect<McpServerRow, RowNotFound | DbError> =>
        queryFirst<McpServerRow>(db, `SELECT * FROM assistant_mcp_servers WHERE id = ?`, id),

      create: (input: CreateMcpServerInput): Effect.Effect<McpServerRow, DbError | ConstraintViolation> =>
        run(
          db,
          `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, secret_ref, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          input.label,
          input.transportType,
          input.url,
          input.command,
          JSON.stringify(input.args),
          input.secretRef,
          input.enabled ? 1 : 0
        ).pipe(
          Effect.flatMap(() => queryFirst<McpServerRow>(db, `SELECT * FROM assistant_mcp_servers WHERE id = ?`, input.id)),
          // The row was just inserted in this statement pair; a missing read is
          // a database fault, not a not-found the caller must handle.
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: `assistant_mcp_servers row '${input.id}' missing after insert` })))
        ),

      update: (id: string, patch: UpdateMcpServerInput): Effect.Effect<McpServerRow, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
          if (patch.transportType !== undefined) { sets.push("transport_type = ?"); params.push(patch.transportType); }
          if (patch.url !== undefined) { sets.push("url = ?"); params.push(patch.url); }
          if (patch.command !== undefined) { sets.push("command = ?"); params.push(patch.command); }
          if (patch.args !== undefined) { sets.push("args = ?"); params.push(JSON.stringify(patch.args)); }
          if (patch.secretRef !== undefined) { sets.push("secret_ref = ?"); params.push(patch.secretRef); }
          if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
          if (sets.length === 0) {
            const current = yield* queryFirst<McpServerRow>(db, `SELECT * FROM assistant_mcp_servers WHERE id = ?`, id);
            return current;
          }
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE assistant_mcp_servers SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<McpServerRow>(db, `SELECT * FROM assistant_mcp_servers WHERE id = ?`, id);
        }),

      remove: (id: string): Effect.Effect<void, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
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
      // interactive transaction. Mirrors assistant-settings.repo.ts's write
      // contract (D1 has no interactive tx — executes sequentially, each
      // statement still atomic).
      setProjectServers: (
        projectId: string,
        entries: Array<{ serverId: string; enabled: boolean }>
      ): Effect.Effect<void, ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            yield* run(db, `DELETE FROM assistant_mcp_project_servers WHERE project_id = ?`, projectId);
            const seen = new Set<string>();
            for (const entry of entries) {
              if (seen.has(entry.serverId)) continue;
              seen.add(entry.serverId);
              yield* run(
                db,
                `INSERT INTO assistant_mcp_project_servers (project_id, server_id, enabled) VALUES (?, ?, ?)`,
                projectId,
                entry.serverId,
                entry.enabled ? 1 : 0
              );
            }
          })
        ),
    };
  }),
}) {}
