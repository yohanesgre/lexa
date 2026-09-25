import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AssistantCallLogsRepo } from "./assistant-call-logs.repo";
import type { AssistantCallLogInput } from "../../shared/assistant";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AssistantCallLogsRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-call-logs-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantCallLogsRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AssistantCallLogsRepo);
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')`);
  db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('prov1','P','http://x','k')`);
}

function insert(id: string, over: Partial<AssistantCallLogInput> = {}) {
  return Effect.runPromise(repo.insert({ id, model: "m1", kind: "openai_compatible", status: "done", ...over }));
}

function setCreatedAt(id: string, ts: string) {
  db.exec(`UPDATE assistant_call_logs SET created_at = '${ts}' WHERE id = '${id}'`);
}

describe("AssistantCallLogsRepo", () => {
  it("insert round-trips usage/token/cost fields; defaults apply; getById", async () => {
    setup();
    const full = await insert("a", {
      projectId: "p1", providerId: "prov1", model: "gpt-x", kind: "anthropic_compatible", status: "done",
      errorCode: null, usageIn: 10, usageOut: 20, cachedIn: 5, latencyMs: 123, costCents: 42, estimated: true,
    });
    expect(full).toMatchObject({
      id: "a", projectId: "p1", providerId: "prov1", model: "gpt-x", kind: "anthropic_compatible",
      status: "done", errorCode: null, usageIn: 10, usageOut: 20, cachedIn: 5, latencyMs: 123,
      costCents: 42, estimated: true,
    });
    expect(typeof full.createdAt).toBe("string");

    const minimal = await insert("b");
    expect(minimal).toMatchObject({
      projectId: null, providerId: null, errorCode: null, usageIn: 0, usageOut: 0, cachedIn: 0,
      latencyMs: null, costCents: 0, estimated: false,
    });

    const byId = await Effect.runPromise(repo.getById("a"));
    expect(byId.model).toBe("gpt-x");
    expect(byId.estimated).toBe(true);

    const missing = await Effect.runPromise(Effect.either(repo.getById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("lists by project/provider/model/recent: created_at DESC and limit", async () => {
    setup();
    await insert("a", { projectId: "p1", providerId: "prov1", model: "m1" });
    await insert("b", { projectId: "p1", providerId: "prov1", model: "m2" });
    await insert("c", { projectId: "p1", providerId: "prov1", model: "m1" });
    await insert("z", { projectId: "p2", providerId: null, model: "m1" });
    setCreatedAt("a", "2026-09-01 00:00:00");
    setCreatedAt("b", "2026-09-02 00:00:00");
    setCreatedAt("c", "2026-09-03 00:00:00");
    setCreatedAt("z", "2026-09-04 00:00:00");

    expect((await Effect.runPromise(repo.listByProject("p1"))).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect((await Effect.runPromise(repo.listByProject("p1", 2))).map((r) => r.id)).toEqual(["c", "b"]);
    expect((await Effect.runPromise(repo.listByProvider("prov1"))).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect((await Effect.runPromise(repo.listByModel("m1"))).map((r) => r.id)).toEqual(["z", "c", "a"]);
    expect((await Effect.runPromise(repo.listRecent())).map((r) => r.id)).toEqual(["z", "c", "b", "a"]);
    expect((await Effect.runPromise(repo.listRecent(1))).map((r) => r.id)).toEqual(["z"]);
    expect(await Effect.runPromise(repo.listByProject("none"))).toEqual([]);
  });

  it("usageStats aggregates tokens/cost/latency/errorRate with filters", async () => {
    setup();
    await insert("a", { projectId: "p1", model: "m1", usageIn: 10, usageOut: 20, cachedIn: 5, latencyMs: 100, costCents: 5 });
    await insert("b", { projectId: "p1", model: "m2", usageIn: 1, usageOut: 2, latencyMs: 200, costCents: 2 });
    await insert("c", { projectId: "p1", model: "m1", status: "error", latencyMs: 300 });
    await insert("d", { projectId: "p2", model: "m3", usageIn: 100, latencyMs: 50, costCents: 50 });
    setCreatedAt("a", "2026-09-01 10:00:00");
    setCreatedAt("b", "2026-09-02 10:00:00");
    setCreatedAt("c", "2026-09-02 11:00:00");
    setCreatedAt("d", "2026-09-01 12:00:00");

    const all = await Effect.runPromise(repo.usageStats());
    expect(all).toMatchObject({
      totalCalls: 4, errorCalls: 1, promptTokens: 111, completionTokens: 22, totalTokens: 138,
      totalCostCents: 57, totalCostUsd: 0.57, avgLatencyMs: 163, p50LatencyMs: 100, p95LatencyMs: 300,
    });
    expect(all.errorRate).toBeCloseTo(0.25);

    const p1 = await Effect.runPromise(repo.usageStats({ projectId: "p1" }));
    expect(p1).toMatchObject({ totalCalls: 3, promptTokens: 11, completionTokens: 22, totalTokens: 38, totalCostCents: 7, totalCostUsd: 0.07, avgLatencyMs: 200, p50LatencyMs: 200, p95LatencyMs: 300 });
    expect(p1.errorRate).toBeCloseTo(1 / 3);

    const day = await Effect.runPromise(repo.usageStats({ projectId: "p1", from: "2026-09-02", to: "2026-09-02" }));
    expect(day).toMatchObject({ totalCalls: 2, totalTokens: 3, avgLatencyMs: 250, p50LatencyMs: 200, p95LatencyMs: 300 });
    expect(day.errorRate).toBeCloseTo(0.5);

    const empty = await Effect.runPromise(repo.usageStats({ projectId: "none" }));
    expect(empty).toMatchObject({ totalCalls: 0, totalTokens: 0, totalCostUsd: 0, avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null, errorRate: 0 });
  });

  it("byDay/byModel/csv group, order, and render", async () => {
    setup();
    await insert("a", { projectId: "p1", model: "m1", usageIn: 10, usageOut: 20, cachedIn: 5, latencyMs: 100, costCents: 5 });
    await insert("b", { projectId: "p1", model: "m2", usageIn: 1, usageOut: 2, latencyMs: 200, costCents: 2 });
    await insert("c", { projectId: "p1", model: "m1", status: "error", latencyMs: 300 });
    setCreatedAt("a", "2026-09-01 10:00:00");
    setCreatedAt("b", "2026-09-02 10:00:00");
    setCreatedAt("c", "2026-09-02 11:00:00");

    const days = await Effect.runPromise(repo.byDay({ projectId: "p1" }));
    expect(days.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(days[0]).toMatchObject({ tokens: 35, costCents: 5, costUsd: 0.05, avgLatencyMs: 100, calls: 1, errorRate: 0 });
    expect(days[1]).toMatchObject({ tokens: 3, costCents: 2, calls: 2, avgLatencyMs: 250 });
    expect(days[1]!.errorRate).toBeCloseTo(0.5);

    const models = await Effect.runPromise(repo.byModel({ projectId: "p1" }));
    expect(models.map((m) => m.model)).toEqual(["m1", "m2"]);
    expect(models[0]).toMatchObject({ tokens: 35, costCents: 5, calls: 2, avgLatencyMs: 200 });
    expect(models[0]!.errorRate).toBeCloseTo(0.5);
    expect(models[1]).toMatchObject({ tokens: 3, calls: 1, errorRate: 0 });

    const csv = await Effect.runPromise(repo.csv({ projectId: "p1" }));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("day,model,tokens,cost_cents,cost_usd,avg_latency_ms,calls,error_rate");
    expect(lines[1]).toBe("2026-09-01,m1,35,5,0.05,100,1,0.0000");
    expect(lines[2]).toBe("2026-09-02,m2,3,2,0.02,200,1,0.0000");
    expect(lines[3]).toBe("2026-09-02,m1,0,0,0.00,300,1,1.0000");
  });

  it("project delete cascades logs; provider delete nulls provider_id", async () => {
    setup();
    await insert("a", { projectId: "p1", providerId: "prov1" });
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(await Effect.runPromise(Effect.either(repo.getById("a")))).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "RowNotFound" }),
    });

    await insert("b", { projectId: "p2", providerId: "prov1" });
    db.exec(`DELETE FROM assistant_providers WHERE id = 'prov1'`);
    const row = await Effect.runPromise(repo.getById("b"));
    expect(row.providerId).toBeNull();
  });
});
