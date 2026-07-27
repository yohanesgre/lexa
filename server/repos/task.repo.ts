import { Effect } from "effect";
import { D1, queryAll, queryFirst, run, batch, DbError, RowNotFound, ConstraintViolation } from "../db/d1";
import { TaskRow, rowToTask } from "../../shared/types";
import type { Task, Priority, TaskType } from "../../shared/types";

export interface TaskFilters {
  columnId?: string;
  swimlaneId?: string;
  assignee?: string;
  type?: TaskType;
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

export class TaskRepo extends Effect.Service<TaskRepo>()("Lexa/TaskRepo", {
  effect: Effect.gen(function* () {
    const db = yield* D1;

    return {
      create: (input: {
        id: string;
        projectId: string;
        columnId: string;
        swimlaneId: string | null;
        title: string;
        description: string;
        priority: Priority;
        type: TaskType;
        assignee: string | null;
        position: string;
        githubIssueId?: string;
        githubIssueNumber?: number;
        githubRepo?: string;
        githubSyncedState?: "open" | "closed" | null;
      }): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, assignee, position, github_issue_id, github_issue_number, github_repo, github_synced_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.columnId,
            input.swimlaneId,
            input.title,
            input.description,
            input.priority,
            input.type,
            input.assignee,
            input.position,
            input.githubIssueId ?? null,
            input.githubIssueNumber ?? null,
            input.githubRepo ?? null,
            input.githubSyncedState ?? null
          );
          return yield* queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, input.id).pipe(
            Effect.map((r) => rowToTask(r))
          );
        }),

      findById: (id: string): Effect.Effect<Task, RowNotFound | DbError> =>
        queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, id).pipe(Effect.map((r) => rowToTask(r))),

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
          conditions.push("t.assignee = ?");
          params.push(filters.assignee);
        }
        if (filters?.type) {
          conditions.push("t.type = ?");
          params.push(filters.type);
        }

        const decoded = decodeCursor(cursor ?? null);
        if (decoded) {
          conditions.push(
            "(t.column_id = ? AND (t.position > ? OR (t.position = ? AND t.id > ?)))"
          );
          params.push(decoded.columnId, decoded.position, decoded.position, decoded.taskId);
        }

        const whereClause = conditions.join(" AND ");
        const sql = `SELECT t.*, c.github_state as column_github_state FROM tasks t LEFT JOIN columns c ON t.column_id = c.id WHERE ${whereClause} ORDER BY t.column_id, t.position LIMIT ?`;
        params.push(limitVal + 1);

        return queryAll<TaskRow & { column_github_state: "open" | "closed" | null }>(db, sql, ...params).pipe(
          Effect.map((rows) => {
            const hasMore = rows.length > limitVal;
            const tasks = rows.slice(0, limitVal).map((r) => rowToTask(r, r.column_github_state));
            return { tasks, hasMore };
          })
        );
      },

      findLastInColumn: (projectId: string, columnId: string): Effect.Effect<TaskRow, RowNotFound | DbError> =>
        queryFirst<TaskRow>(
          db,
          `SELECT * FROM tasks WHERE project_id = ? AND column_id = ? ORDER BY position DESC LIMIT 1`,
          projectId,
          columnId
        ),

      update: (
        id: string,
        input: {
          title?: string;
          description?: string;
          priority?: Priority;
          type?: TaskType;
          assignee?: string | null;
        }
      ): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> => {
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
        if (input.assignee !== undefined) {
          sets.push("assignee = ?");
          params.push(input.assignee);
        }
        if (sets.length === 0)
          return queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, id).pipe(
            Effect.map((r) => rowToTask(r))
          );
        sets.push("updated_at = datetime('now')");
        params.push(id);
        return run(db, `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, id)))
          .pipe(Effect.map((r) => rowToTask(r)));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM tasks WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      findByGithubIssue: (githubIssueId: string): Effect.Effect<Task, RowNotFound | DbError> =>
        queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE github_issue_id = ?`, githubIssueId).pipe(
          Effect.map((r) => rowToTask(r))
        ),

      setGithubLink: (taskId: string, link: { issueId: string; issueNumber: number; repo: string }): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `UPDATE tasks SET github_issue_id = ?, github_issue_number = ?, github_repo = ?, updated_at = datetime('now') WHERE id = ?`,
          link.issueId,
          link.issueNumber,
          link.repo,
          taskId
        ).pipe(Effect.map(() => undefined)),

      setGithubSyncedState: (taskId: string, state: "open" | "closed"): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `UPDATE tasks SET github_synced_state = ?, updated_at = datetime('now') WHERE id = ?`,
          state,
          taskId
        ).pipe(Effect.map(() => undefined)),

      move: (
        taskId: string,
        target: { columnId: string; swimlaneId: string | null; position: string; projectId: string },
        opts?: { bypassWip?: boolean }
      ): Effect.Effect<{ changes: number; task: Task }, RowNotFound | DbError | ConstraintViolation> => {
        const changes = opts?.bypassWip
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
                 AND (column_id = ?2 OR (SELECT COUNT(*) FROM tasks WHERE project_id = ?5 AND column_id = ?2) < COALESCE((SELECT wip_limit FROM columns WHERE id = ?2), 9223372036854775807))`,
              taskId,
              target.columnId,
              target.swimlaneId,
              target.position,
              target.projectId
            );

        return changes.pipe(
          Effect.flatMap((n) =>
            queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, taskId).pipe(
              Effect.map((r) => ({ changes: n, task: rowToTask(r) }))
            )
          )
        );
      },
      moveFromWebhook: (
        taskId: string,
        target: { columnId: string; swimlaneId: string | null; position: string },
        syncedState: "open" | "closed"
      ): Effect.Effect<Task, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* batch(db, [
            {
              sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
              params: [target.columnId, target.swimlaneId, target.position, taskId],
            },
            {
              sql: `UPDATE tasks SET github_synced_state = ?, updated_at = datetime('now') WHERE id = ?`,
              params: [syncedState, taskId],
            },
          ]);
          return yield* queryFirst<TaskRow>(db, `SELECT * FROM tasks WHERE id = ?`, taskId).pipe(
            Effect.map((r) => rowToTask(r))
          );
        }),
    };
  }),
}) {}
