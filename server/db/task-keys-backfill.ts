import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { generateTaskKey } from "../task-key";
import { queryAll, run } from "./db";
import type { DbDriver, DbError, ConstraintViolation } from "./db";

export function backfillTaskKeys(db: Database): void {
  const projects = db
    .query("SELECT id, slug FROM projects WHERE key IS NULL ORDER BY created_at, rowid")
    .all() as { id: string; slug: string }[];
  const taken = new Set(
    (db.query("SELECT key FROM projects WHERE key IS NOT NULL").all() as { key: string }[]).map((r) => r.key)
  );
  for (const p of projects) {
    const key = generateTaskKey(p.slug, (c) => taken.has(c));
    db.prepare("UPDATE projects SET key = ? WHERE id = ?").run(key, p.id);
    taken.add(key);
  }
  const tasks = db
    .query(
      "SELECT t.id, t.project_id, p.key AS project_key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key IS NULL ORDER BY t.created_at, t.rowid"
    )
    .all() as { id: string; project_id: string; project_key: string }[];
  const counters = new Map<string, number>();
  for (const t of tasks) {
    const n = (counters.get(t.project_id) ?? 0) + 1;
    counters.set(t.project_id, n);
    db.prepare("UPDATE tasks SET number = ?, key = ? WHERE id = ?").run(n, `${t.project_key}-${n}`, t.id);
  }
  // Advance the per-project counters so the next service-created task
  // continues after the backfilled max (numbers are never reused).
  for (const [projectId, n] of counters) {
    db.prepare("UPDATE projects SET next_task_number = ? WHERE id = ?").run(n, projectId);
  }
}
// Same backfill through the async DbDriver (HTTP seed handler; the Bun boot
// path uses the sync version above). Logic must stay in lockstep: project
// keys for NULL-key projects, sequential per-project task numbers, and
// next_task_number advanced past the backfilled max.
export const backfillTaskKeysDriver = (driver: DbDriver): Effect.Effect<void, DbError | ConstraintViolation> =>
  Effect.gen(function* () {
    const projects = yield* queryAll<{ id: string; slug: string }>(
      driver, "SELECT id, slug FROM projects WHERE key IS NULL ORDER BY created_at, rowid"
    );
    const taken = new Set(
      (yield* queryAll<{ key: string }>(driver, "SELECT key FROM projects WHERE key IS NOT NULL")).map((r) => r.key)
    );
    for (const p of projects) {
      const key = generateTaskKey(p.slug, (c) => taken.has(c));
      yield* run(driver, "UPDATE projects SET key = ? WHERE id = ?", key, p.id);
      taken.add(key);
    }
    const tasks = yield* queryAll<{ id: string; project_id: string; project_key: string }>(
      driver,
      "SELECT t.id, t.project_id, p.key AS project_key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key IS NULL ORDER BY t.created_at, t.rowid"
    );
    const counters = new Map<string, number>();
    for (const t of tasks) {
      const n = (counters.get(t.project_id) ?? 0) + 1;
      counters.set(t.project_id, n);
      yield* run(driver, "UPDATE tasks SET number = ?, key = ? WHERE id = ?", n, `${t.project_key}-${n}`, t.id);
    }
    for (const [projectId, n] of counters) {
      yield* run(driver, "UPDATE projects SET next_task_number = ? WHERE id = ?", n, projectId);
    }
  });
