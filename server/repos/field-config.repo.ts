import { Effect } from "effect";
import { Sqlite, queryAll, run, batch, DbError, ConstraintViolation } from "../db/database";
import { PriorityOptionRow, TypeOptionRow, rowToFieldOption } from "../../shared/db";
import type { FieldConfig, FieldOption } from "../../shared/types";

type FieldKind = "priority" | "type";

function table(kind: FieldKind): string {
  return kind === "priority" ? "priority_options" : "type_options";
}

export class FieldConfigRepo extends Effect.Service<FieldConfigRepo>()("Lexa/FieldConfigRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      findByProject: (projectId: string): Effect.Effect<FieldConfig, DbError> =>
        Effect.gen(function* () {
          const [priorityRows, typeRows] = yield* Effect.all([
            queryAll<PriorityOptionRow>(db, `SELECT * FROM priority_options WHERE project_id = ? ORDER BY position`, projectId),
            queryAll<TypeOptionRow>(db, `SELECT * FROM type_options WHERE project_id = ? ORDER BY position`, projectId),
          ]);
          return {
            priorities: priorityRows.map(rowToFieldOption),
            types: typeRows.map(rowToFieldOption),
          };
        }),

      findPrioritiesByProject: (projectId: string): Effect.Effect<FieldOption[], DbError> =>
        queryAll<PriorityOptionRow>(db, `SELECT * FROM priority_options WHERE project_id = ? ORDER BY position`, projectId).pipe(
          Effect.map((rows) => rows.map(rowToFieldOption))
        ),

      findTypesByProject: (projectId: string): Effect.Effect<FieldOption[], DbError> =>
        queryAll<TypeOptionRow>(db, `SELECT * FROM type_options WHERE project_id = ? ORDER BY position`, projectId).pipe(
          Effect.map((rows) => rows.map(rowToFieldOption))
        ),

      // First option (position 0) = create default + dashboard "urgent" equivalent.
      findFirstPriority: (projectId: string): Effect.Effect<FieldOption | null, DbError> =>
        queryAll<PriorityOptionRow>(db, `SELECT * FROM priority_options WHERE project_id = ? ORDER BY position LIMIT 1`, projectId).pipe(
          Effect.map((rows) => (rows[0] ? rowToFieldOption(rows[0]) : null))
        ),

      createOption: (input: { id: string; projectId: string; label: string; color: string; position: number }, kind: FieldKind): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO ${table(kind)} (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`,
          input.id,
          input.projectId,
          input.label,
          input.color,
          input.position
        ).pipe(Effect.map(() => undefined)),

      updateOption: (id: string, input: { label?: string; color?: string; position?: number }, kind: FieldKind): Effect.Effect<void, ConstraintViolation | DbError> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.label !== undefined) {
          sets.push("label = ?");
          params.push(input.label);
        }
        if (input.color !== undefined) {
          sets.push("color = ?");
          params.push(input.color);
        }
        if (input.position !== undefined) {
          sets.push("position = ?");
          params.push(input.position);
        }
        if (sets.length === 0) return Effect.succeed(undefined);
        sets.push("updated_at = datetime('now')");
        params.push(id);
        return run(db, `UPDATE ${table(kind)} SET ${sets.join(", ")} WHERE id = ?`, ...params).pipe(Effect.map(() => undefined));
      },

      deleteOption: (id: string, kind: FieldKind): Effect.Effect<number, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM ${table(kind)} WHERE id = ?`, id),

      countTasksUsing: (optionId: string, kind: FieldKind): Effect.Effect<number, DbError> =>
        queryAll<{ c: number }>(
          db,
          kind === "priority"
            ? `SELECT COUNT(*) as c FROM tasks WHERE priority = ?`
            : `SELECT COUNT(*) as c FROM tasks WHERE type = ?`,
          optionId
        ).pipe(Effect.map((rows) => rows[0]?.c ?? 0)),

      // Replace the whole list for a project atomically (used by PUT field-config).
      replaceList: (projectId: string, kind: FieldKind, options: { id: string; label: string; color: string; position: number }[]): Effect.Effect<void, ConstraintViolation | DbError> => {
        const t = table(kind);
        const stmts: { sql: string; params: unknown[] }[] = [
          { sql: `DELETE FROM ${t} WHERE project_id = ?`, params: [projectId] },
          ...options.map((o) => ({
            sql: `INSERT INTO ${t} (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`,
            params: [o.id, projectId, o.label, o.color, o.position],
          })),
        ];
        return batch(db, stmts);
      },

      // Create the default 4+4 options for a brand-new project.
      seedDefaults: (projectId: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        batch(db, [
          { sql: `INSERT INTO priority_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Urgent", "#FF4444", 0] },
          { sql: `INSERT INTO priority_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "High", "#F0C040", 1] },
          { sql: `INSERT INTO priority_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Medium", "#22D3EE", 2] },
          { sql: `INSERT INTO priority_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Low", "#6B6560", 3] },
          { sql: `INSERT INTO type_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Feature", "#4ADE80", 0] },
          { sql: `INSERT INTO type_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Bug", "#FF4444", 1] },
          { sql: `INSERT INTO type_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Task", "#22D3EE", 2] },
          { sql: `INSERT INTO type_options (id, project_id, label, color, position) VALUES (?, ?, ?, ?, ?)`, params: [crypto.randomUUID(), projectId, "Asset", "#F472B6", 3] },
        ]),
    };
  }),
}) {}
