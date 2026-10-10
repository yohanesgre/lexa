import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { getAssistantRunById } from "./run-registry";

const DDL = `CREATE TABLE assistant_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  thread_key    TEXT NOT NULL,
  parent_run_id TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('chat_run', 'document', 'schedule')),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  goal          TEXT NOT NULL,
  result        TEXT,
  error         TEXT,
  budget_ms     INTEGER,
  steps_used    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
)`;

function fresh() {
  const db = new Database(":memory:");
  db.exec(DDL);
  const driver = createBunSqliteDriver(db);
  return { db, driver };
}

function insertRun(db: Database, id: string, projectId: string, status: string): void {
  db.prepare(
    `INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, budget_ms, created_by, steps_used)
     VALUES (?, ?, 'chat:c1', 'chat_run', ?, 'do a thing', 1000, 'u1', 3)`
  ).run(id, projectId, status);
}

async function runEither<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.either(effect));
}

describe("getAssistantRunById", () => {
  it("reads a run by id and maps snake_case columns to the shared shape", async () => {
    const { db, driver } = fresh();
    insertRun(db, "r1", "p1", "completed");

    const outcome = await runEither(getAssistantRunById(driver, "r1"));
    if (outcome._tag === "Left") throw new Error("unexpected failure");
    expect(outcome.right).toMatchObject({
      id: "r1",
      projectId: "p1",
      threadKey: "chat:c1",
      kind: "chat_run",
      status: "completed",
      goal: "do a thing",
      budgetMs: 1000,
      stepsUsed: 3,
      createdBy: "u1",
    });
  });

  it("returns RowNotFound for an unknown id (the caller maps it to 404)", async () => {
    const { driver } = fresh();
    const outcome = await runEither(getAssistantRunById(driver, "nope"));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left._tag).toBe("RowNotFound");
  });
});
