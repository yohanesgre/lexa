import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { RuntimeRow, ForgeTaskRow, rowToRuntime, rowToForgeTask } from "../../shared/db";
import type { Runtime, ForgeTask, ForgeProvider, ForgeAction } from "../../shared/types";

export class ForgeRepo extends Effect.Service<ForgeRepo>()("Lexa/ForgeRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      // ── Runtimes ──
      registerRuntime: (input: { id: string; name: string; provider: ForgeProvider; hostname: string }): Effect.Effect<Runtime, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO runtimes (id, name, provider, status, hostname, last_seen)
             VALUES (?, ?, ?, 'online', ?, datetime('now'))`,
            input.id,
            input.name,
            input.provider,
            input.hostname
          );
          return rowToRuntime({
            id: input.id,
            name: input.name,
            provider: input.provider,
            status: "online",
            hostname: input.hostname,
            last_seen: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
        }),

      updateRuntimeHeartbeat: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET status = 'online', last_seen = datetime('now') WHERE id = ?`, id).pipe(
          Effect.map(() => undefined)
        ),

      markRuntimesOffline: (): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE runtimes SET status = 'offline' WHERE last_seen < datetime('now', '-2 minutes')`).pipe(
          Effect.map(() => undefined)
        ),

      findRuntimeById: (id: string): Effect.Effect<Runtime, RowNotFound | DbError> =>
        queryFirst<RuntimeRow>(db, `SELECT * FROM runtimes WHERE id = ?`, id).pipe(Effect.map(rowToRuntime)),

      listRuntimes: (): Effect.Effect<Runtime[], DbError> =>
        queryAll<RuntimeRow>(db, `SELECT * FROM runtimes ORDER BY created_at`).pipe(
          Effect.map((rows) => rows.map(rowToRuntime))
        ),

      // ── Tasks ──
      createTask: (input: {
        id: string;
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        action: ForgeAction;
        selection: string;
        docContext: string;
        runtimeId?: string;          // preferred runtime (set at claim time if omitted)
      }): Effect.Effect<ForgeTask, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO forge_tasks (id, project_id, document_type, document_id, action, selection, doc_context, status, runtime_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
            input.id,
            input.projectId,
            input.documentType,
            input.documentId,
            input.action,
            input.selection,
            input.docContext,
            input.runtimeId ?? null
          );
          return yield* queryFirst<ForgeTaskRow>(db, `SELECT * FROM forge_tasks WHERE id = ?`, input.id).pipe(
            Effect.map(rowToForgeTask)
          );
        }),

      findTaskById: (id: string): Effect.Effect<ForgeTask, RowNotFound | DbError> =>
        queryFirst<ForgeTaskRow>(db, `SELECT * FROM forge_tasks WHERE id = ?`, id).pipe(Effect.map(rowToForgeTask)),

      // Claim a queued task for a runtime. A task pinned to a specific runtime
      // (runtime_id set at create) may ONLY be claimed by that runtime.
      // Unpinned tasks (runtime_id null) are claimable by anyone, FIFO.
      claimNextTask: (runtimeId: string): Effect.Effect<ForgeTask | null, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<ForgeTaskRow>(
            db,
            `SELECT * FROM forge_tasks
             WHERE status = 'queued'
               AND (runtime_id IS NULL OR runtime_id = ?)
             ORDER BY (runtime_id = ?) DESC, created_at
             LIMIT 1`,
            runtimeId,
            runtimeId
          );
          const task = rows[0];
          if (!task) return null;
          yield* run(
            db,
            `UPDATE forge_tasks SET status = 'running', runtime_id = ?, started_at = datetime('now') WHERE id = ? AND status = 'queued'`,
            runtimeId,
            task.id
          );
          const updated = yield* queryFirst<ForgeTaskRow>(db, `SELECT * FROM forge_tasks WHERE id = ?`, task.id).pipe(
            Effect.map(rowToForgeTask)
          );
          // If the conditional update lost the race, return null (someone else claimed it).
          return updated.status === "running" && updated.runtimeId === runtimeId ? updated : null;
        }),

      updateTaskStatus: (id: string, status: ForgeTask["status"], result?: string | null, error?: string | null): Effect.Effect<ForgeTask, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets = ["status = ?", "finished_at = datetime('now')"];
          const params: unknown[] = [status];
          if (result !== undefined) {
            sets.push("result = ?");
            params.push(result);
          }
          if (error !== undefined) {
            sets.push("error = ?");
            params.push(error);
          }
          params.push(id);
          yield* run(db, `UPDATE forge_tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<ForgeTaskRow>(db, `SELECT * FROM forge_tasks WHERE id = ?`, id).pipe(
            Effect.map(rowToForgeTask)
          );
        }),

      listTasksForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<ForgeTask[], DbError> =>
        queryAll<ForgeTaskRow>(
          db,
          `SELECT * FROM forge_tasks WHERE project_id = ? AND document_type = ? AND document_id = ? ORDER BY created_at DESC LIMIT 20`,
          projectId,
          documentType,
          documentId
        ).pipe(Effect.map((rows) => rows.map(rowToForgeTask))),

      // Recent tasks across all projects (for the navbar status bar).
      listRecent: (limit = 10): Effect.Effect<Array<ForgeTask & { project_name: string; document_title: string }>, DbError> =>
        queryAll<ForgeTaskRow & { project_name: string; document_title: string }>(
          db,
          `SELECT ft.*, p.name as project_name,
                  CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
                       ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END as document_title
           FROM forge_tasks ft
           INNER JOIN projects p ON p.id = ft.project_id
           ORDER BY ft.created_at DESC
           LIMIT ?`,
          limit
        ).pipe(
          Effect.map((rows) => rows.map((r) => ({ ...rowToForgeTask(r), project_name: r.project_name, document_title: r.document_title ?? "" })))
        ),
    };
  }),
}) {}
