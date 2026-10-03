import { describe, expect, it, beforeEach } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import {
  countActiveRuns,
  createAssistantRun,
  getAssistantRun,
  isRunTransitionable,
  reconcileStaleRuns,
  transitionAssistantRunRegistry,
} from "./run-registry";
import type { AssistantRunStatus } from "../../shared/assistant";

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

async function runEither<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.either(effect));
}

const BASE = { projectId: "p1", threadKey: "chat:c1", kind: "chat_run" as const, goal: "do a thing" };

describe("assistant run registry", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh();
  });

  it("creates a queued row and maps snake_case columns to the shared shape", async () => {
    const outcome = await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1", budgetMs: 1000, createdBy: "u1" }));
    if (outcome._tag === "Left") throw new Error("unexpected failure");
    expect(outcome.right).toMatchObject({
      id: "r1",
      projectId: "p1",
      threadKey: "chat:c1",
      kind: "chat_run",
      status: "queued",
      goal: "do a thing",
      budgetMs: 1000,
      stepsUsed: 0,
      createdBy: "u1",
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it("generates an id when none is supplied", async () => {
    const outcome = await runEither(createAssistantRun(ctx.driver, BASE));
    if (outcome._tag === "Left") throw new Error("unexpected failure");
    expect(outcome.right.id.length).toBeGreaterThan(10);
  });

  it("transitions queued→running→completed with timestamps and result", async () => {
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1" }));
    const running = await runEither(
      transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p1", status: "running" })
    );
    if (running._tag === "Left") throw new Error("unexpected failure");
    expect(running.right.changed).toBe(true);
    expect(running.right.run.status).toBe("running");
    expect(running.right.run.startedAt).not.toBeNull();
    expect(running.right.run.finishedAt).toBeNull();

    const done = await runEither(
      transitionAssistantRunRegistry(ctx.driver, {
        runId: "r1",
        projectId: "p1",
        status: "completed",
        result: "all done",
        stepsUsed: 4,
      })
    );
    if (done._tag === "Left") throw new Error("unexpected failure");
    expect(done.right.run.status).toBe("completed");
    expect(done.right.run.result).toBe("all done");
    expect(done.right.run.stepsUsed).toBe(4);
    expect(done.right.run.finishedAt).not.toBeNull();
  });

  it("is idempotent: a repeated terminal transition is a clean no-op", async () => {
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1" }));
    await runEither(transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p1", status: "completed", result: "one" }));
    const repeat = await runEither(
      transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p1", status: "completed", result: "two" })
    );
    if (repeat._tag === "Left") throw new Error("unexpected failure");
    expect(repeat.right.changed).toBe(false);
    expect(repeat.right.run.result).toBe("one");
  });

  it("refuses an illegal regression (completed→running)", async () => {
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1" }));
    await runEither(transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p1", status: "completed" }));
    const regress = await runEither(transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p1", status: "running" }));
    if (regress._tag === "Left") throw new Error("unexpected failure");
    expect(regress.right.changed).toBe(false);
    expect(regress.right.run.status).toBe("completed");
  });

  it("returns RowNotFound for an unknown or cross-project run", async () => {
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1" }));
    const missing = await runEither(transitionAssistantRunRegistry(ctx.driver, { runId: "nope", projectId: "p1", status: "running" }));
    expect(missing._tag).toBe("Left");
    const wrongProject = await runEither(
      transitionAssistantRunRegistry(ctx.driver, { runId: "r1", projectId: "p2", status: "running" })
    );
    expect(wrongProject._tag).toBe("Left");
    const read = await runEither(getAssistantRun(ctx.driver, "r1", "p2"));
    expect(read._tag).toBe("Left");
  });

  it("counts active (queued|running) runs per thread and project", async () => {
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r1" }));
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r2", threadKey: "chat:c2" }));
    await runEither(createAssistantRun(ctx.driver, { ...BASE, id: "r3", projectId: "p2", threadKey: "chat:c1" }));
    await runEither(transitionAssistantRunRegistry(ctx.driver, { runId: "r2", projectId: "p1", status: "completed" }));
    const counts = await Effect.runPromise(countActiveRuns(ctx.driver, "p1", "chat:c1"));
    expect(counts).toEqual({ thread: 1, project: 1 });
  });

  it("classifies transitions", () => {
    const cases: Array<[AssistantRunStatus, AssistantRunStatus, boolean]> = [
      ["queued", "running", true],
      ["running", "running", false],
      ["completed", "running", false],
      ["queued", "completed", true],
      ["running", "failed", true],
      ["cancelled", "completed", false],
    ];
    for (const [from, to, expected] of cases) expect(isRunTransitionable(from, to)).toBe(expected);
  });
});

describe("reconcileStaleRuns", () => {
  let ctx: ReturnType<typeof fresh>;
  beforeEach(() => {
    ctx = fresh();
  });

  function insertRow(id: string, status: "queued" | "running", budgetMs: number | null, createdAt: string, startedAt: string | null) {
    ctx.db.prepare(
      "INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, budget_ms, created_at, started_at) VALUES (?, 'p1', 'chat:c1', 'chat_run', ?, 'g', ?, ?, ?)"
    ).run(id, status, budgetMs, createdAt, startedAt);
  }

  it("fails stale queued/running rows, uses the default budget for NULL budget_ms, and leaves fresh runs", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    // Stale queued: never started, 1h old, 60s budget → expires 6m after create.
    insertRow("stale-queued", "queued", 60_000, "2026-01-01 11:00:00", null);
    // Stale running: started 40m ago, 10m budget → expires 15m after start.
    insertRow("stale-running", "running", 600_000, "2026-01-01 11:00:00", "2026-01-01 11:20:00");
    // NULL budget_ms, 20m old → default 10m + grace 5m → stale.
    insertRow("null-budget", "queued", null, "2026-01-01 11:40:00", null);
    // NULL budget_ms but only 2m old → inside the default window → untouched.
    insertRow("fresh", "queued", null, "2026-01-01 11:58:00", null);

    const result = await Effect.runPromise(reconcileStaleRuns(ctx.driver, { now }));
    expect(result.failed).toBe(3);

    const failed = ctx.db.prepare("SELECT id, status, error, finished_at FROM assistant_runs WHERE status = 'failed' ORDER BY id").all() as Array<{
      id: string;
      status: string;
      error: string;
      finished_at: string | null;
    }>;
    expect(failed.map((r) => r.id)).toEqual(["null-budget", "stale-queued", "stale-running"]);
    for (const r of failed) {
      expect(r.error).toBe("run exceeded its wall-clock budget");
      expect(r.finished_at).not.toBeNull();
    }
    expect(ctx.db.prepare("SELECT status FROM assistant_runs WHERE id = 'fresh'").get()).toMatchObject({ status: "queued" });
  });

  it("surfaces a DbError instead of throwing (fail-open at the caller)", async () => {
    ctx.db.exec("DROP TABLE assistant_runs");
    const outcome = await runEither(reconcileStaleRuns(ctx.driver, { now: new Date("2026-01-01T12:00:00Z") }));
    expect(outcome._tag).toBe("Left");
  });
});
