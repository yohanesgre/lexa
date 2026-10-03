import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, type SqlParam, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { AssistantTaskRow, rowToAssistantTask } from "../../shared/db";
import type { AssistantTask, AssistantTaskStatus } from "../../shared/types";

// Terminal status UPDATE, mirroring `updateTaskStatus`. `RETURNING id` lets a
// batched caller tell a matched transition from a vanished row.
const buildUpdateTaskStatusStmt = (id: string, status: AssistantTask["status"], result?: string | null, error?: string | null): BatchStmt => {
  const sets = ["status = ?", "finished_at = datetime('now')"];
  const params: SqlParam[] = [status];
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
  return { sql: `UPDATE assistant_tasks SET ${sets.join(", ")} WHERE id = ? AND ${from} RETURNING id`, params };
};

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

export type AdminAssistantRunKind = "chat_run" | "document" | "schedule";

export interface AdminAssistantRunRow {
  id: string;
  key: string;
  projectId: string;
  kind: AdminAssistantRunKind;
  documentType: "task" | "wiki" | null;
  documentId: string;
  documentTitle: string;
  agentId: string;
  skillId: string;
  agentName: string;
  skillName: string;
  threadKey: string | null;
  status: AssistantTaskStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface AdminRunRaw {
  id: string;
  key: string | null;
  project_id: string;
  kind: AdminAssistantRunKind;
  document_type: "task" | "wiki" | null;
  document_id: string | null;
  document_title: string | null;
  agent_id: string | null;
  skill_id: string | null;
  agent_name: string | null;
  skill_name: string | null;
  thread_key: string | null;
  status: AssistantTaskStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// Union the document-run tier (assistant_tasks) with the delegation/schedule
// registry (assistant_runs). Document rows present as kind 'document'; registry
// rows carry their own kind and null document fields. Column order/types are
// aligned so the caller can filter/sort/page the union as one relation.
const RUNS_UNION = `
  SELECT ft.id AS id,
         CASE WHEN ft.document_type = 'task' THEN COALESCE((SELECT key FROM tasks WHERE id = ft.document_id), '')
              ELSE '' END AS key,
         ft.project_id AS project_id,
         'document' AS kind,
         ft.document_type AS document_type,
         ft.document_id AS document_id,
         CASE WHEN ft.document_type = 'task' THEN (SELECT title FROM tasks WHERE id = ft.document_id)
              ELSE (SELECT title FROM wiki_pages WHERE slug = ft.document_id) END AS document_title,
         ft.agent_id AS agent_id,
         ft.skill_id AS skill_id,
         fa.name AS agent_name,
         fs.name AS skill_name,
         ft.document_type || ':' || ft.document_id AS thread_key,
         ft.status AS status,
         ft.error AS error,
         ft.created_at AS created_at,
         ft.started_at AS started_at,
         ft.finished_at AS finished_at
  FROM assistant_tasks ft
  LEFT JOIN lexa_agents fa ON fa.id = ft.agent_id
  LEFT JOIN lexa_skills fs ON fs.id = ft.skill_id
  UNION ALL
  SELECT r.id AS id,
         r.id AS key,
         r.project_id AS project_id,
         r.kind AS kind,
         NULL AS document_type,
         NULL AS document_id,
         NULL AS document_title,
         NULL AS agent_id,
         NULL AS skill_id,
         NULL AS agent_name,
         NULL AS skill_name,
         r.thread_key AS thread_key,
         r.status AS status,
         r.error AS error,
         r.created_at AS created_at,
         r.started_at AS started_at,
         r.finished_at AS finished_at
  FROM assistant_runs r
`;

function mapAdminRunRow(row: AdminRunRaw): AdminAssistantRunRow {
  return {
    id: row.id,
    key: row.key ?? row.id,
    projectId: row.project_id,
    kind: row.kind,
    documentType: row.document_type,
    documentId: row.document_id ?? "",
    documentTitle: row.document_title ?? "",
    agentId: row.agent_id ?? "",
    skillId: row.skill_id ?? "",
    agentName: row.agent_name ?? "",
    skillName: row.skill_name ?? "",
    threadKey: row.thread_key,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

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
      updateTaskStatusStmt: buildUpdateTaskStatusStmt,

      updateTaskStatus: (id: string, status: AssistantTask["status"], result?: string | null, error?: string | null): Effect.Effect<AssistantTask, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const stmt = buildUpdateTaskStatusStmt(id, status, result, error);
          yield* run(
            db,
            stmt.sql,
            ...stmt.params
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

      // ── Admin runs list: union of document runs (assistant_tasks) and the
      // delegation/schedule registry (assistant_runs) (ADR-0004 §3; plan H3/H7).
      // Document rows present as kind 'document'; registry rows carry their own
      // kind and nullable document fields. Keyset pagination stays on
      // (created_at DESC, id DESC); the status/project/kind filters apply to the
      // union, and counts are the unfiltered GROUP BY over both tables.
      listRecentRuns: (input: {
        status?: AssistantTaskStatus | null;
        projectId?: string | null;
        kind?: AdminAssistantRunKind | null;
        limit: number;
        cursor?: { createdAt: string; id: string } | null;
      }): Effect.Effect<{ runs: AdminAssistantRunRow[]; nextCursor: { createdAt: string; id: string } | null }, DbError> =>
        Effect.gen(function* () {
          const conds: string[] = [];
          const params: unknown[] = [];
          if (input.status) {
            conds.push("u.status = ?");
            params.push(input.status);
          }
          if (input.projectId) {
            conds.push("u.project_id = ?");
            params.push(input.projectId);
          }
          if (input.kind) {
            conds.push("u.kind = ?");
            params.push(input.kind);
          }
          if (input.cursor) {
            conds.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
            params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.id);
          }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const rows = yield* queryAll<AdminRunRaw>(
            db,
            `SELECT u.* FROM (${RUNS_UNION}) u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
            ...params,
            input.limit + 1
          );
          const hasMore = rows.length > input.limit;
          const page = hasMore ? rows.slice(0, input.limit) : rows;
          const last = page[page.length - 1];
          const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null;
          return { runs: page.map(mapAdminRunRow), nextCursor };
        }),

      countRunsByStatus: (): Effect.Effect<Record<AssistantTaskStatus, number>, DbError> =>
        queryAll<{ status: AssistantTaskStatus; n: number }>(
          db,
          `SELECT status, COUNT(*) AS n
           FROM (SELECT status FROM assistant_tasks UNION ALL SELECT status FROM assistant_runs)
           GROUP BY status`
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
