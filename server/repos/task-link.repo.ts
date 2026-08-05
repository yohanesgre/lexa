import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { TaskLinkRow, rowToTaskLink } from "../../shared/db";
import type { TaskLink, TaskLinkRelation } from "../../shared/types";

export class TaskLinkRepo extends Effect.Service<TaskLinkRepo>()("Lexa/TaskLinkRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: {
        id: string;
        projectId: string;
        fromTaskId: string;
        toTaskId: string;
        relation: TaskLinkRelation;
      }): Effect.Effect<TaskLink, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO task_links (id, project_id, from_task_id, to_task_id, relation)
             VALUES (?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.fromTaskId,
            input.toTaskId,
            input.relation
          );
          return rowToTaskLink({
            id: input.id,
            project_id: input.projectId,
            from_task_id: input.fromTaskId,
            to_task_id: input.toTaskId,
            relation: input.relation,
            created_at: new Date().toISOString(),
          });
        }),

      findById: (id: string): Effect.Effect<TaskLink, RowNotFound | DbError> =>
        queryFirst<TaskLinkRow>(db, `SELECT * FROM task_links WHERE id = ?`, id).pipe(Effect.map(rowToTaskLink)),

      findByTask: (taskId: string): Effect.Effect<TaskLink[], DbError> =>
        queryAll<TaskLinkRow>(
          db,
          `SELECT * FROM task_links WHERE from_task_id = ? OR to_task_id = ? ORDER BY created_at`,
          taskId,
          taskId
        ).pipe(Effect.map((rows) => rows.map(rowToTaskLink))),

      findByProject: (projectId: string): Effect.Effect<TaskLink[], DbError> =>
        queryAll<TaskLinkRow>(db, `SELECT * FROM task_links WHERE project_id = ? ORDER BY created_at`, projectId).pipe(
          Effect.map((rows) => rows.map(rowToTaskLink))
        ),

      // Direct children of a task (subtask_of links where to = parent).
      findChildren: (taskId: string): Effect.Effect<TaskLink[], DbError> =>
        queryAll<TaskLinkRow>(
          db,
          `SELECT * FROM task_links WHERE to_task_id = ? AND relation = 'subtask_of' ORDER BY created_at`,
          taskId
        ).pipe(Effect.map((rows) => rows.map(rowToTaskLink))),

      // Ancestors of a task (subtask_of chain walking up).
      findParents: (taskId: string): Effect.Effect<TaskLink[], DbError> =>
        queryAll<TaskLinkRow>(
          db,
          `SELECT * FROM task_links WHERE from_task_id = ? AND relation = 'subtask_of' ORDER BY created_at`,
          taskId
        ).pipe(Effect.map((rows) => rows.map(rowToTaskLink))),

      delete: (id: string): Effect.Effect<number, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM task_links WHERE id = ?`, id),

      // Task search for @-autocomplete (title match, exclude archived + self).
      search: (projectId: string, query: string, excludeTaskId: string, limit = 10): Effect.Effect<Array<{ id: string; title: string; column_name: string; type: string; priority: string }>, DbError> =>
        queryAll<{ id: string; title: string; column_name: string; type: string; priority: string }>(
          db,
          `SELECT t.id, t.title, c.name as column_name, t.type, t.priority
           FROM tasks t
           INNER JOIN columns c ON t.column_id = c.id
           WHERE t.project_id = ?
             AND t.archived_at IS NULL
             AND t.id != ?
             AND t.title LIKE ? ESCAPE '\\'
           ORDER BY t.updated_at DESC
           LIMIT ?`,
          projectId,
          excludeTaskId,
          `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`,
          limit
        ),
    };
  }),
}) {}
