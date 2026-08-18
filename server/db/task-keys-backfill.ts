import type { Database } from "bun:sqlite";
import { generateTaskKey } from "../task-key";

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