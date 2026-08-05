import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, batch, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { TaskRow, rowToTask, rowToTaskSlim } from "../../shared/db";
import type { Task } from "../../shared/types";

export interface TaskFilters {
  columnId?: string;
  swimlaneId?: string;
  assignee?: string;
  type?: string;              // type_options.id
  includeArchived?: boolean;
}

function decodeCursor(cursor: string | null): { columnId: string; position: string; taskId: string } | null {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const [columnId, position, taskId] = decoded.split(":");
    if (!columnId || !position || !taskId) return null;
    return { columnId, position, taskId };
  } catch {
    return null;
  }
}

const TASK_SELECT = `t.*, c.github_state as column_github_state, GROUP_CONCAT(ta.user_name, '||') AS assignees, COALESCE(GROUP_CONCAT(gi.issue_id || ',' || gi.issue_number || ',' || gi.repo || ',' || COALESCE(gi.synced_state,''), '||'), '') AS github_issues_raw`;

// Slim variant for list/board/anchor paths — no t.description (the TipTap
// blob is only needed for get/update/mutation responses).
const TASK_SELECT_SLIM = `t.id, t.project_id, t.column_id, t.swimlane_id, t.title, t.priority, t.type, t.position, t.archived_at, t.github_issue_id, t.github_issue_number, t.github_repo, t.github_synced_state, t.created_at, t.updated_at, c.github_state as column_github_state, GROUP_CONCAT(ta.user_name, '||') AS assignees, COALESCE(GROUP_CONCAT(gi.issue_id || ',' || gi.issue_number || ',' || gi.repo || ',' || COALESCE(gi.synced_state,''), '||'), '') AS github_issues_raw`;

const TASK_FROM = `tasks t LEFT JOIN columns c ON t.column_id = c.id LEFT JOIN task_assignees ta ON ta.task_id = t.id LEFT JOIN task_github_issues gi ON gi.task_id = t.id`;

type SlimTaskRow = Omit<TaskRow, "description"> & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null };

export class TaskRepo extends Effect.Service<TaskRepo>()("Lexa/TaskRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: {
        id: string;
        projectId: string;
        columnId: string;
        swimlaneId: string;
        title: string;
        description: string;
        priority: string;
        type: string;
        assignees?: string[];
        position: string;
        githubIssueId?: string;
        githubIssueNumber?: number;
        githubRepo?: string;
        githubSyncedState?: "open" | "closed" | null;
      }): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* Effect.logDebug("[TaskRepo] create");
          yield* run(
            db,
            `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.columnId,
            input.swimlaneId,
            input.title,
            input.description,
            input.priority,
            input.type,
            input.position
          );
          if (input.assignees && input.assignees.length > 0) {
            const stmts = input.assignees.map((name) => ({
              sql: `INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)`,
              params: [input.id, name],
            }));
            yield* batch(db, stmts);
          }
          if (input.githubIssueId && input.githubIssueNumber && input.githubRepo) {
            yield* run(
              db,
              `INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES (?, ?, ?, ?, ?)`,
              input.id,
              input.githubIssueId,
              input.githubIssueNumber,
              input.githubRepo,
              input.githubSyncedState ?? null
            );
          }
          return yield* queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
            db,
            `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
            input.id
          ).pipe(Effect.map((r) => rowToTask(r)));
        }),

      findById: (id: string): Effect.Effect<Task, RowNotFound | DbError> =>
        queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
          db,
          `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
          id
        ).pipe(Effect.map((r) => rowToTask(r))),

      findByProject: (
        projectId: string,
        filters?: TaskFilters,
        limit?: number,
        cursor?: string
      ): Effect.Effect<{ tasks: Task[]; hasMore: boolean }, DbError> => {
        const limitVal = limit ?? 50;
        const conditions: string[] = ["t.project_id = ?"];
        const params: unknown[] = [projectId];

        if (filters?.columnId) {
          conditions.push("t.column_id = ?");
          params.push(filters.columnId);
        }
        if (filters?.swimlaneId) {
          conditions.push("t.swimlane_id = ?");
          params.push(filters.swimlaneId);
        }
        if (filters?.assignee) {
          conditions.push("EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id = t.id AND ta2.user_name = ?)");
          params.push(filters.assignee);
        }
        if (filters?.type) {
          conditions.push("t.type = ?");
          params.push(filters.type);
        }
        if (!filters?.includeArchived) {
          conditions.push("t.archived_at IS NULL");
        }

        const decoded = decodeCursor(cursor ?? null);
        if (decoded) {
          conditions.push(
            "(t.column_id > ? OR (t.column_id = ? AND t.position > ?) OR (t.column_id = ? AND t.position = ? AND t.id > ?))"
          );
          params.push(decoded.columnId, decoded.columnId, decoded.position, decoded.columnId, decoded.position, decoded.taskId);
        }

        const whereClause = conditions.join(" AND ");
        const sql = `SELECT ${TASK_SELECT_SLIM} FROM ${TASK_FROM} WHERE ${whereClause} GROUP BY t.id ORDER BY t.column_id, t.position LIMIT ?`;
        params.push(limitVal + 1);

        return queryAll<SlimTaskRow>(db, sql, ...params).pipe(
          Effect.map((rows) => {
            const hasMore = rows.length > limitVal;
            const tasks = rows.slice(0, limitVal).map((r) => rowToTaskSlim(r, r.column_github_state));
            return { tasks, hasMore };
          })
        );
      },

      findAllByProject: (
        projectId: string,
        filters?: TaskFilters
      ): Effect.Effect<Task[], DbError> => {
        const conditions: string[] = ["t.project_id = ?"];
        const params: unknown[] = [projectId];

        if (filters?.columnId) {
          conditions.push("t.column_id = ?");
          params.push(filters.columnId);
        }
        if (filters?.swimlaneId) {
          conditions.push("t.swimlane_id = ?");
          params.push(filters.swimlaneId);
        }
        if (filters?.assignee) {
          conditions.push("EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id = t.id AND ta2.user_name = ?)");
          params.push(filters.assignee);
        }
        if (filters?.type) {
          conditions.push("t.type = ?");
          params.push(filters.type);
        }
        if (!filters?.includeArchived) {
          conditions.push("t.archived_at IS NULL");
        }

        const whereClause = conditions.join(" AND ");
        const sql = `SELECT ${TASK_SELECT_SLIM} FROM ${TASK_FROM} WHERE ${whereClause} GROUP BY t.id ORDER BY t.column_id, t.position`;

        return queryAll<SlimTaskRow>(db, sql, ...params).pipe(
          Effect.map((rows) => rows.map((r) => rowToTaskSlim(r, r.column_github_state)))
        );
      },

      findLastInColumn: (projectId: string, columnId: string): Effect.Effect<Task, RowNotFound | DbError> =>
        queryFirst<SlimTaskRow>(
          db,
          `SELECT ${TASK_SELECT_SLIM} FROM ${TASK_FROM} WHERE t.project_id = ? AND t.column_id = ? AND t.archived_at IS NULL GROUP BY t.id ORDER BY t.position DESC LIMIT 1`,
          projectId,
          columnId
        ).pipe(Effect.map((r) => rowToTaskSlim(r, r.column_github_state))),

      update: (
        id: string,
        input: {
          title?: string;
          description?: string;
          priority?: string;
          type?: string;
          assignees?: string[];
        }
      ): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          if (input.assignees !== undefined) {
            yield* run(db, `DELETE FROM task_assignees WHERE task_id = ?`, id);
            if (input.assignees.length > 0) {
              const stmts = input.assignees.map((name) => ({
                sql: `INSERT INTO task_assignees (task_id, user_name) VALUES (?, ?)`,
                params: [id, name],
              }));
              yield* batch(db, stmts);
            }
          }
          const sets: string[] = [];
          const params: unknown[] = [];
          if (input.title !== undefined) {
            sets.push("title = ?");
            params.push(input.title);
          }
          if (input.description !== undefined) {
            sets.push("description = ?");
            params.push(input.description);
          }
          if (input.priority !== undefined) {
            sets.push("priority = ?");
            params.push(input.priority);
          }
          if (input.type !== undefined) {
            sets.push("type = ?");
            params.push(input.type);
          }
          if (sets.length === 0)
            return yield* queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
              db,
              `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
              id
            ).pipe(Effect.map((r) => rowToTask(r)));
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* Effect.logDebug(`[TaskRepo] update id=${id}`);
          yield* run(db, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
            db,
            `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
            id
          ).pipe(Effect.map((r) => rowToTask(r)));
        }),

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        Effect.logDebug(`[TaskRepo] delete id=${id}`).pipe(
          Effect.flatMap(() => run(db, `DELETE FROM tasks WHERE id = ?`, id).pipe(Effect.map(() => undefined)))
        ),

      findByGithubIssue: (githubIssueId: string): Effect.Effect<Task, RowNotFound | DbError> =>
        queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
          db,
          `SELECT ${TASK_SELECT} FROM tasks t INNER JOIN task_github_issues gi_filter ON gi_filter.task_id = t.id INNER JOIN columns c ON t.column_id = c.id LEFT JOIN task_assignees ta ON ta.task_id = t.id LEFT JOIN task_github_issues gi ON gi.task_id = t.id WHERE gi_filter.issue_id = ? GROUP BY t.id`,
          githubIssueId
        ).pipe(Effect.map((r) => rowToTask(r))),

      setGithubLink: (taskId: string, link: { issueId: string; issueNumber: number; repo: string }): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES (?, ?, ?, ?)`,
          taskId,
          link.issueId,
          link.issueNumber,
          link.repo
        ).pipe(Effect.map(() => undefined)),

      setGithubSyncedState: (taskId: string, issueId: string, state: "open" | "closed"): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `UPDATE task_github_issues SET synced_state = ? WHERE task_id = ? AND issue_id = ?`,
          state,
          taskId,
          issueId
        ).pipe(Effect.map(() => undefined)),

      unlinkGithubIssue: (taskId: string, issueId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `DELETE FROM task_github_issues WHERE task_id = ? AND issue_id = ?`,
          taskId,
          issueId
        ).pipe(Effect.map(() => undefined)),

      createSubtaskLink: (projectId: string, fromTaskId: string, toTaskId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO task_links (id, project_id, from_task_id, to_task_id, relation)
           VALUES (?, ?, ?, ?, 'subtask_of')`,
          crypto.randomUUID(),
          projectId,
          fromTaskId,
          toTaskId
        ).pipe(Effect.map(() => undefined)),

      findSubtasks: (taskId: string): Effect.Effect<Array<{ id: string; position: string }>, DbError> =>
        queryAll<{ id: string; position: string }>(
          db,
          `SELECT t.id, t.position FROM task_links tl
           INNER JOIN tasks t ON t.id = tl.from_task_id
           WHERE tl.to_task_id = ? AND tl.relation = 'subtask_of'
           ORDER BY t.position`,
          taskId
        ),

      move: (
        taskId: string,
        target: { columnId: string; swimlaneId: string; position: string; projectId: string },
        opts?: { bypassWip?: boolean }
      ): Effect.Effect<{ changes: number; task: Task }, RowNotFound | DbError | ConstraintViolation> => {
        const changes = Effect.logDebug(`[TaskRepo] move id=${taskId} columnId=${target.columnId} position=${target.position}`).pipe(
          Effect.flatMap(() =>
            opts?.bypassWip
              ? run(
                  db,
                  `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
                  target.columnId,
                  target.swimlaneId,
                  target.position,
                  taskId
                )
              : run(
                  db,
                  `UPDATE tasks SET column_id = ?2, swimlane_id = ?3, position = ?4, updated_at = datetime('now')
                   WHERE id = ?1
                     AND (column_id = ?2 OR (SELECT COUNT(*) FROM tasks WHERE project_id = ?5 AND column_id = ?2 AND archived_at IS NULL) < COALESCE((SELECT wip_limit FROM columns WHERE id = ?2), 9223372036854775807))`,
                  taskId,
                  target.columnId,
                  target.swimlaneId,
                  target.position,
                  target.projectId
                )
          )
        );

        return changes.pipe(
          Effect.flatMap((n) =>
            queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
              db,
              `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
              taskId
            ).pipe(
              Effect.map((r) => ({ changes: n, task: rowToTask(r) }))
            )
          )
        );
      },
      countByProject: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ cnt: number }>(db, `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND archived_at IS NULL`, projectId).pipe(
          Effect.map((rows) => rows[0]?.cnt ?? 0)
        ),

      countUrgent: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ cnt: number }>(
          db,
          `SELECT COUNT(*) as cnt FROM tasks t
           WHERE t.project_id = ?
             AND t.archived_at IS NULL
             AND t.priority = (SELECT id FROM priority_options WHERE project_id = ? ORDER BY position LIMIT 1)`,
          projectId,
          projectId
        ).pipe(Effect.map((rows) => rows[0]?.cnt ?? 0)),

      countOutOfSync: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ cnt: number }>(
          db,
          `SELECT COUNT(DISTINCT t.id) as cnt FROM tasks t
           INNER JOIN columns c ON t.column_id = c.id
           INNER JOIN task_github_issues gi ON gi.task_id = t.id
           WHERE t.project_id = ?
             AND t.archived_at IS NULL
             AND gi.synced_state IS NOT c.github_state`,
          projectId
        ).pipe(Effect.map((rows) => rows[0]?.cnt ?? 0)),

      countByColumn: (projectId: string, columnId: string): Effect.Effect<number, DbError> =>
        queryAll<{ cnt: number }>(db, `SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND column_id = ? AND archived_at IS NULL`, projectId, columnId).pipe(
          Effect.map((rows) => rows[0]?.cnt ?? 0)
        ),

      findUrgentAcrossAllProjects: (limit: number): Effect.Effect<Array<{ id: string; title: string; project_name: string; project_slug: string; column_name: string; priority: string }>, DbError> =>
        queryAll<{ id: string; title: string; project_name: string; project_slug: string; column_name: string; priority: string }>(
          db,
          `SELECT t.id, t.title, p.name as project_name, p.slug as project_slug, c.name as column_name, t.priority
           FROM tasks t
           INNER JOIN projects p ON t.project_id = p.id
           INNER JOIN columns c ON t.column_id = c.id
           WHERE t.priority = (SELECT id FROM priority_options WHERE project_id = p.id ORDER BY position LIMIT 1)
             AND t.archived_at IS NULL
           ORDER BY t.created_at DESC
           LIMIT ?`,
          limit
        ),

      findOutOfSyncAcrossAllProjects: (limit: number): Effect.Effect<Array<{ id: string; title: string; project_name: string; project_slug: string; repo: string; issue_number: number }>, DbError> =>
        queryAll<{ id: string; title: string; project_name: string; project_slug: string; repo: string; issue_number: number }>(
          db,
          `SELECT t.id, t.title, p.name as project_name, p.slug as project_slug, gi.repo, gi.issue_number
           FROM tasks t
           INNER JOIN projects p ON t.project_id = p.id
           INNER JOIN columns c ON t.column_id = c.id
           INNER JOIN task_github_issues gi ON gi.task_id = t.id
           WHERE gi.synced_state IS NOT c.github_state
             AND t.archived_at IS NULL
           ORDER BY t.updated_at DESC
           LIMIT ?`,
          limit
        ),

      setArchived: (id: string, archivedAt: string | null): Effect.Effect<Task, DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* Effect.logDebug(`[TaskRepo] setArchived id=${id} archivedAt=${archivedAt}`);
          yield* run(db, `UPDATE tasks SET archived_at = ?, updated_at = datetime('now') WHERE id = ?`, archivedAt, id);
          return yield* queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
            db,
            `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
            id
          ).pipe(Effect.map((r) => rowToTask(r)));
        }),

      moveFromWebhook: (
        taskId: string,
        issueId: string,
        target: { columnId: string; swimlaneId: string; position: string },
        syncedState: "open" | "closed"
      ): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* batch(db, [
            {
              sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
              params: [target.columnId, target.swimlaneId, target.position, taskId],
            },
            {
              sql: `UPDATE task_github_issues SET synced_state = ? WHERE task_id = ? AND issue_id = ?`,
              params: [syncedState, taskId, issueId],
            },
          ]);
          return yield* queryFirst<TaskRow & { column_github_state: "open" | "closed" | null; github_issues_raw: string | null }>(
            db,
            `SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.id = ? GROUP BY t.id`,
            taskId
          ).pipe(Effect.map((r) => rowToTask(r)));
        }),
    };
  }),
}) {}
