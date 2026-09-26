import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { AssistantTaskRow, rowToAssistantTask } from "../../shared/db";
import type { AssistantTask, AssistantTaskStatus } from "../../shared/types";

// Assistant tasks are always read joined with their document's title and the
// agent/skill names so the UI can show names instead of raw ids.
const TASK_SELECT = `
  SELECT ft.*,
         CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
              ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END AS document_title,
         CASE WHEN ft.document_type = 'task' THEN COALESCE((SELECT key FROM tasks WHERE id = ft.document_id), '')
              ELSE '' END AS key,
         fa.name AS agent_name,
         fs.name AS skill_name
  FROM assistant_tasks ft
  LEFT JOIN lexa_agents fa ON fa.id = ft.agent_id
  LEFT JOIN lexa_skills fs ON fs.id = ft.skill_id
`;

export class AssistantTaskRepo extends Effect.Service<AssistantTaskRepo>()("Lexa/AssistantTaskRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      createTask: (input: {
        id: string;
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        agentId: string;
        skillId: string;
        extraPrompt: string;
        selection: string;
      }): Effect.Effect<AssistantTask, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
            input.id,
            input.projectId,
            input.documentType,
            input.documentId,
            input.agentId,
            input.skillId,
            input.extraPrompt,
            input.selection
          );
          return yield* queryFirst<AssistantTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, input.id).pipe(
            Effect.map(rowToAssistantTask)
          );
        }),

      findTaskById: (id: string): Effect.Effect<AssistantTask, RowNotFound | DbError> =>
        queryFirst<AssistantTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, id).pipe(Effect.map(rowToAssistantTask)),

      // Assistant stream handler claims its task with a conditional UPDATE —
      // status-scoped so a double claim (retry, concurrent stream) loses the
      // race and surfaces as ConstraintViolation.
      claimAssistantTask: (taskId: string): Effect.Effect<AssistantTask, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const changes = yield* run(
            db,
            `UPDATE assistant_tasks SET status = 'running', started_at = datetime('now')
             WHERE id = ? AND status = 'queued'`,
            taskId
          );
          if (changes === 0) {
            return yield* Effect.fail(new ConstraintViolation({ message: `task ${taskId} is not a queued assistant task`, isPositionConflict: false }));
          }
          return yield* queryFirst<AssistantTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, taskId).pipe(
            Effect.map(rowToAssistantTask)
          );
        }),

      // Terminal status writes. Cancel wins over a late complete/fail: complete
      // and fail only transition from 'running', cancel from 'queued' or
      // 'running'. A no-op (0 rows changed) returns the row unchanged.
      updateTaskStatus: (id: string, status: AssistantTask["status"], result?: string | null, error?: string | null): Effect.Effect<AssistantTask, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets = ["status = ?", "finished_at = datetime('now')"];
          const params: unknown[] = [status];
          if (result !== undefined) {
            sets.push("result = ?");
            params.push(result === null ? null : result.slice(0, 1024 * 1024));
          }
          if (error !== undefined) {
            sets.push("error = ?");
            params.push(error === null ? null : error.slice(0, 2000));
          }
          const from =
            status === "cancelled" ? "status IN ('queued', 'running')" : "status = 'running'";
          params.push(id);
          yield* run(
            db,
            `UPDATE assistant_tasks SET ${sets.join(", ")} WHERE id = ? AND ${from}`,
            ...params
          );
          return yield* queryFirst<AssistantTaskRow>(db, `${TASK_SELECT} WHERE ft.id = ?`, id).pipe(
            Effect.map(rowToAssistantTask)
          );
        }),

      listTasksForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<AssistantTask[], DbError> =>
        queryAll<AssistantTaskRow>(
          db,
          `${TASK_SELECT}
           WHERE ft.project_id = ? AND ft.document_type = ? AND ft.document_id = ?
           ORDER BY ft.created_at DESC
           LIMIT 20`,
          projectId,
          documentType,
          documentId
        ).pipe(Effect.map((rows) => rows.map(rowToAssistantTask))),

      // Keyset page over assistant_tasks for the admin runs list. Fetches
      // limit+1 rows so the caller can tell whether a next page exists; the
      // returned cursor is the last row of the page, ordered (created_at DESC,
      // id DESC) — matching idx_assistant_tasks_created.
      listRecent: (input: {
        status?: AssistantTaskStatus | null;
        projectId?: string | null;
        limit: number;
        cursor?: { createdAt: string; id: string } | null;
      }): Effect.Effect<{ tasks: AssistantTask[]; nextCursor: { createdAt: string; id: string } | null }, DbError> =>
        Effect.gen(function* () {
          const conds: string[] = [];
          const params: unknown[] = [];
          if (input.status) {
            conds.push("ft.status = ?");
            params.push(input.status);
          }
          if (input.projectId) {
            conds.push("ft.project_id = ?");
            params.push(input.projectId);
          }
          if (input.cursor) {
            conds.push("(ft.created_at < ? OR (ft.created_at = ? AND ft.id < ?))");
            params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
          }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const rows = yield* queryAll<AssistantTaskRow>(
            db,
            `${TASK_SELECT} ${where} ORDER BY ft.created_at DESC, ft.id DESC LIMIT ?`,
            ...params,
            input.limit + 1
          );
          const hasMore = rows.length > input.limit;
          const page = hasMore ? rows.slice(0, input.limit) : rows;
          const last = page[page.length - 1];
          const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null;
          return { tasks: page.map(rowToAssistantTask), nextCursor };
        }),

      countByStatus: (): Effect.Effect<Record<AssistantTaskStatus, number>, DbError> =>
        queryAll<{ status: AssistantTaskStatus; n: number }>(
          db,
          `SELECT status, COUNT(*) AS n FROM assistant_tasks GROUP BY status`
        ).pipe(
          Effect.map((rows) => {
            const counts: Record<AssistantTaskStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
            for (const r of rows) counts[r.status] = r.n;
            return counts;
          })
        ),

      // Tasks referencing an agent/skill (delete guards — an entity still in
      // use by queued/running/history rows cannot be removed).
      countTasksByAgent: (agentId: string): Effect.Effect<number, DbError> =>
        queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assistant_tasks WHERE agent_id = ?`, agentId).pipe(
          Effect.map((rows) => rows[0]!?.n ?? 0)
        ),

      countTasksBySkill: (skillId: string): Effect.Effect<number, DbError> =>
        queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assistant_tasks WHERE skill_id = ?`, skillId).pipe(
          Effect.map((rows) => rows[0]!?.n ?? 0)
        ),
    };
  }),
}) {}
