import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, type BatchStmt, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { ColumnRow, rowToColumn } from "../../shared/db";
import type { Column } from "../../shared/types";

export interface ColumnCreateInput {
  id: string;
  projectId: string;
  name: string;
  position: number;
  color?: string;
  wipLimit?: number | null;
  requiredFields?: string[];
  githubState?: "open" | "closed" | null;
  isDone?: boolean;
}

const COLUMN_INSERT_SQL = `INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state, is_done)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const columnInsertParams = (input: ColumnCreateInput): unknown[] => [
  input.id,
  input.projectId,
  input.name,
  input.position,
  input.color ?? "#6b7280",
  input.wipLimit ?? null,
  JSON.stringify(input.requiredFields ?? []),
  input.githubState ?? null,
  input.isDone ? 1 : 0,
];

export class ColumnRepo extends Effect.Service<ColumnRepo>()("Lexa/ColumnRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      createStmt: (input: ColumnCreateInput): BatchStmt => ({
        sql: COLUMN_INSERT_SQL,
        params: columnInsertParams(input) as BatchStmt["params"],
      }),

      create: (input: ColumnCreateInput): Effect.Effect<Column, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* Effect.logDebug("[ColumnRepo] create");
          yield* run(
            db,
            COLUMN_INSERT_SQL,
            ...columnInsertParams(input)
          );
          return yield* queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, input.id).pipe(
            Effect.map(rowToColumn)
          );
        }),

      findById: (id: string): Effect.Effect<Column, RowNotFound | DbError> =>
        queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id).pipe(Effect.map(rowToColumn)),

      findByProject: (projectId: string): Effect.Effect<Column[], DbError> =>
        queryAll<ColumnRow>(
          db,
          `SELECT * FROM columns WHERE project_id = ? ORDER BY position`,
          projectId
        ).pipe(Effect.map((rows) => rows.map(rowToColumn))),

      update: (
        id: string,
        input: {
          name?: string;
          position?: number;
          color?: string;
          wipLimit?: number | null;
          requiredFields?: string[];
          githubState?: "open" | "closed" | null;
          isDone?: boolean;
        }
      ): Effect.Effect<Column, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.name !== undefined) {
          sets.push("name = ?");
          params.push(input.name);
        }
        if (input.position !== undefined) {
          sets.push("position = ?");
          params.push(input.position);
        }
        if (input.color !== undefined) {
          sets.push("color = ?");
          params.push(input.color);
        }
        if (input.wipLimit !== undefined) {
          sets.push("wip_limit = ?");
          params.push(input.wipLimit);
        }
        if (input.requiredFields !== undefined) {
          sets.push("required_fields = ?");
          params.push(JSON.stringify(input.requiredFields));
        }
        if (input.githubState !== undefined) {
          sets.push("github_state = ?");
          params.push(input.githubState);
        }
        if (input.isDone !== undefined) {
          sets.push("is_done = ?");
          params.push(input.isDone ? 1 : 0);
        }
        if (sets.length === 0)
          return queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id).pipe(Effect.map(rowToColumn));
        params.push(id);
        return Effect.logDebug(`[ColumnRepo] update id=${id}`).pipe(
          Effect.flatMap(() => run(db, `UPDATE columns SET ${sets.join(", ")} WHERE id = ?`, ...params).pipe(
            Effect.flatMap(() => queryFirst<ColumnRow>(db, `SELECT * FROM columns WHERE id = ?`, id)),
            Effect.map(rowToColumn)
          ))
        );
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM columns WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      maxPosition: (projectId: string): Effect.Effect<number, DbError> =>
        queryAll<{ mp: number }>(
          db,
          `SELECT COALESCE(MAX(position), -1) as mp FROM columns WHERE project_id = ?`,
          projectId
        ).pipe(Effect.map((rows) => rows[0]!?.mp ?? -1)),

      countTasks: (columnId: string): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM tasks WHERE column_id = ?`, columnId).pipe(
          Effect.map((rows) => rows[0]!?.c ?? 0)
        ),
    };
  }),
}) {}
