import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { generateTaskKey } from "../task-key";
import { queryAll, run, withTx } from "./db";
import type { DbDriver, DbError, ConstraintViolation } from "./db";

interface BackfillProject {
  id: string;
  slug: string;
}

interface BackfillTask {
  id: string;
  project_id: string;
  project_key: string;
}

function assignProjectKeys(
  projects: BackfillProject[],
  taken: Set<string>,
  update: (key: string, id: string) => void
): void {
  for (const p of projects) {
    const key = generateTaskKey(p.slug, (c) => taken.has(c));
    update(key, p.id);
    taken.add(key);
  }
}

function seedCounters(maxRows: { project_id: string; max: number }[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const r of maxRows) counters.set(r.project_id, r.max);
  return counters;
}

function assignTaskNumbers(
  tasks: BackfillTask[],
  counters: Map<string, number>,
  update: (number: number, key: string, id: string) => void
): void {
  for (const t of tasks) {
    const n = (counters.get(t.project_id) ?? 0) + 1;
    counters.set(t.project_id, n);
    update(n, `${t.project_key}-${n}`, t.id);
  }
}

export function backfillTaskKeys(db: Database): void {
  db.transaction(() => {
    const projects = db
      .query("SELECT id, slug FROM projects WHERE key IS NULL ORDER BY created_at, rowid")
      .all() as BackfillProject[];
    const taken = new Set(
      (db.query("SELECT key FROM projects WHERE key IS NOT NULL").all() as { key: string }[]).map((r) => r.key)
    );
    assignProjectKeys(projects, taken, (key, id) => {
      db.prepare("UPDATE projects SET key = ? WHERE id = ?").run(key, id);
    });

    const maxRows = db
      .query("SELECT project_id, MAX(number) AS max FROM tasks WHERE number IS NOT NULL GROUP BY project_id")
      .all() as { project_id: string; max: number }[];
    const counters = seedCounters(maxRows);

    const tasks = db
      .query(
        "SELECT t.id, t.project_id, p.key AS project_key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key IS NULL OR t.number IS NULL ORDER BY t.created_at, t.rowid"
      )
      .all() as BackfillTask[];
    assignTaskNumbers(tasks, counters, (number, key, id) => {
      db.prepare("UPDATE tasks SET number = ?, key = ? WHERE id = ?").run(number, key, id);
    });

    // next_task_number holds the last assigned number (task create
    // pre-increments it), so storing the highest assigned number makes the
    // next service-created task continue the sequence without reuse.
    for (const [projectId, n] of counters) {
      db.prepare("UPDATE projects SET next_task_number = MAX(next_task_number, ?) WHERE id = ?").run(n, projectId);
    }
  })();
}

// Same backfill through the async DbDriver (HTTP seed handler; the Bun boot
// path uses the sync version above). Logic must stay in lockstep: project
// keys for NULL-key projects, per-project task numbers seeded from the
// highest already-assigned number, and next_task_number advanced past it.
export const backfillTaskKeysDriver = (driver: DbDriver): Effect.Effect<void, DbError | ConstraintViolation> =>
  withTx(driver, Effect.gen(function* () {
    const projects = yield* queryAll<BackfillProject>(
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

    const maxRows = yield* queryAll<{ project_id: string; max: number }>(
      driver,
      "SELECT project_id, MAX(number) AS max FROM tasks WHERE number IS NOT NULL GROUP BY project_id"
    );
    const counters = seedCounters(maxRows);

    const tasks = yield* queryAll<BackfillTask>(
      driver,
      "SELECT t.id, t.project_id, p.key AS project_key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key IS NULL OR t.number IS NULL ORDER BY t.created_at, t.rowid"
    );
    for (const t of tasks) {
      const n = (counters.get(t.project_id) ?? 0) + 1;
      counters.set(t.project_id, n);
      yield* run(driver, "UPDATE tasks SET number = ?, key = ? WHERE id = ?", n, `${t.project_key}-${n}`, t.id);
    }
    for (const [projectId, n] of counters) {
      yield* run(driver, "UPDATE projects SET next_task_number = MAX(next_task_number, ?) WHERE id = ?", n, projectId);
    }
  }));
