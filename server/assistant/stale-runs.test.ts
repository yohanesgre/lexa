import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { sweepStaleAssistantTasks, STALE_ASSISTANT_TASK_MS } from "./stale-runs";

const DDL = `CREATE TABLE assistant_tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  skill_id      TEXT,
  extra_prompt  TEXT NOT NULL DEFAULT '',
  selection     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE TABLE task_activity (task_id TEXT, type TEXT)`;

function fresh() {
  const db = new Database(":memory:");
  db.exec(DDL);
  const driver = createBunSqliteDriver(db);
  return { db, driver };
}

function insert(
  db: Database,
  id: string,
  status: "queued" | "running" | "completed" | "failed",
  createdAt: string,
  startedAt: string | null
) {
  db.prepare(
    `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, status, created_at, started_at)
     VALUES (?, 'p1', 'task', 't1', 'asst', ?, ?, ?)`
  ).run(id, status, createdAt, startedAt);
}

describe("sweepStaleAssistantTasks", () => {
  it("fails only stale running rows; leaves fresh running and other-status rows alone", async () => {
    const { db, driver } = fresh();
    const now = new Date("2026-01-01T12:00:00Z");
    // Started 60m ago → stale.
    insert(db, "stale-started", "running", "2026-01-01 09:00:00", "2026-01-01 11:00:00");
    // Lost its started_at: COALESCE falls back to created_at, 45m old → stale.
    insert(db, "stale-never-started", "running", "2026-01-01 11:15:00", null);
    // Old created_at but fresh started_at → the COALESCE must win on started_at.
    insert(db, "fresh-started", "running", "2026-01-01 08:00:00", "2026-01-01 11:45:00");
    // Non-running statuses are never swept, however old.
    insert(db, "queued-old", "queued", "2026-01-01 09:00:00", null);
    insert(db, "completed-old", "completed", "2026-01-01 09:00:00", null);
    insert(db, "failed-old", "failed", "2026-01-01 09:00:00", null);

    const { failed } = await Effect.runPromise(sweepStaleAssistantTasks(driver, { now }));
    expect(failed).toBe(2);

    const rows = db
      .prepare("SELECT id, status, error, finished_at FROM assistant_tasks ORDER BY id")
      .all() as Array<{ id: string; status: string; error: string | null; finished_at: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["stale-started"]!.status).toBe("failed");
    expect(byId["stale-never-started"]!.status).toBe("failed");
    for (const id of ["stale-started", "stale-never-started"]) {
      expect(byId[id]!.error).toBe("run abandoned");
      expect(byId[id]!.finished_at).not.toBeNull();
    }
    expect(byId["fresh-started"]!.status).toBe("running");
    expect(byId["queued-old"]!.status).toBe("queued");
    expect(byId["completed-old"]!.status).toBe("completed");
    expect(byId["failed-old"]!.status).toBe("failed");

    // Direct UPDATE, not a transition: no timeline row (invariant #12).
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(0);

    // Idempotent: a second sweep finds nothing.
    const again = await Effect.runPromise(sweepStaleAssistantTasks(driver, { now }));
    expect(again.failed).toBe(0);
  });

  it("uses a 30-minute default bound", () => {
    expect(STALE_ASSISTANT_TASK_MS).toBe(30 * 60_000);
  });
});
