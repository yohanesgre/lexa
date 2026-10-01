// Worker-side read-tool executor + per-turn gating (ADR-0003 §B.5/§D, P3 WS3).
//
// `worker-tools.ts` is the Worker half of the DO tool path: it resolves the
// project's `assistant_settings`, bound skills and Jev config for one turn, and
// executes the read tools through the same `buildAssistantTools` the Bun path
// uses. These tests drive it against a real bun-sqlite database (migrations
// applied) with the same `Db | RuntimeEnv` base layer `workers-entry.ts` wires
// per request, so the SQL and the layer composition — not just the pure
// helpers — are exercised.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Layer } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { DbBunLive } from "../db/db";
import { RuntimeEnvLive, type RuntimeEnv } from "../runtime-env";
import { encryptSecret, parseMasterKey } from "./secrets";
import {
  buildWorkerReadToolExecutor,
  resolveWorkerJevConfig,
  resolveWorkerTurnContext,
} from "./worker-tools";
import type { ReadToolResponse } from "./tools-ai";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

// A real 32-byte AES-GCM key so the Jev registry path (envelope encrypt/decrypt)
// is the production one; the plaintext only has to survive round-tripping.
const MASTER_KEY = Buffer.from("j".repeat(32)).toString("base64");
const JEV_BASE_URL = "https://typesafe.test";
const JEV_PLAINTEXT = "jev-test-key";
const jevSeed = await (async () => {
  const key = await parseMasterKey(MASTER_KEY);
  const sealed = await encryptSecret(JEV_PLAINTEXT, "jev", "default", key);
  return { ciphertext: sealed.ciphertextB64, iv: sealed.ivB64, keyId: sealed.keyId };
})();

const ENV = { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv;

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-worker-tools-"));
  runMigrations(join(dir, "test.db"), MIGRATIONS);
  db = new Database(join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
});

afterAll(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM assistant_jev_secrets");
  db.exec("DELETE FROM assistant_jev_projects");
  db.exec("DELETE FROM assistant_settings");
  db.exec("DELETE FROM lexa_agent_skills");
  db.exec("DELETE FROM lexa_skills");
  db.exec("DELETE FROM lexa_agents");
  db.exec("DELETE FROM task_assignees");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM columns");
  db.exec("DELETE FROM swimlanes");
  db.exec("DELETE FROM projects");
  // The singleton config row is seeded by migration 0013; reset it in place
  // (deleting it would make `getConfig` a DbError, not a clean default).
  db.exec(`UPDATE assistant_jev_config SET enabled = 0, base_url = '${JEV_BASE_URL}', model = 'jev-latest' WHERE id = 'default'`);
  db.exec("INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')");
});

const driver = () => createBunSqliteDriver(db);
const base = (env: RuntimeEnv = ENV) => Layer.mergeAll(DbBunLive(db), RuntimeEnvLive(env));

function seedSettings(over: { searchApiKey?: string | null; writeTools?: string; images?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO assistant_settings (project_id, search_api_key, write_tools, primary_supports_images)
     VALUES ('p1', ?, ?, ?)`
  ).run(over.searchApiKey ?? null, over.writeTools ?? "", over.images ? 1 : 0);
}

function seedBoundSkill(): void {
  db.exec("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('assistant', 'Assistant', '', '', 1)");
  db.exec("INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk', 'Test Skill', '', 'do the thing', 1)");
  db.exec("INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('assistant', 'sk')");
}

function seedJev(): void {
  db.exec("UPDATE assistant_jev_config SET enabled = 1 WHERE id = 'default'");
  db.prepare(
    `INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', ?, ?, ?, 'test')`
  ).run(jevSeed.ciphertext, jevSeed.iv, jevSeed.keyId);
  db.exec("INSERT INTO assistant_jev_projects (project_id, enabled) VALUES ('p1', 1)");
}

function seedBoard(): void {
  db.exec("INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 1)");
  db.exec("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 1, 'backlog')");
  db.prepare(
    `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, priority, type, position, key, number)
     VALUES ('t1', 'p1', 'c1', 's1', 'Fix login', 'medium', 'task', 'a0', 'P-1', 1)`
  ).run();
}

describe("resolveWorkerTurnContext gating", () => {
  it("offers web_search/get_skill when configured, and drops jev_assess/analyze_image", async () => {
    seedSettings({ searchApiKey: "exa-key", writeTools: "create_task,archive_task", images: true });
    seedBoundSkill();

    const context = await resolveWorkerTurnContext({ driver: driver(), base: base() }, "p1");

    expect(context.readTools).toContain("web_search");
    expect(context.readTools).toContain("get_skill");
    expect(context.readTools).toContain("get_board_structure");
    // Jev is not enabled and the legacy `vision_model` column is gone, so the
    // delegate mode is unreachable — `analyze_image` is never offered.
    expect(context.readTools).not.toContain("jev_assess");
    expect(context.readTools).not.toContain("analyze_image");
    expect(context.writeTools).toEqual(["create_task", "archive_task"]);
    expect(context.primarySupportsImages).toBe(true);
    expect(context.jevConfigured).toBe(false);
  });

  it("drops web_search/get_skill when the project has neither a key nor bound skills", async () => {
    const context = await resolveWorkerTurnContext({ driver: driver(), base: base() }, "p1");

    expect(context.readTools).not.toContain("web_search");
    expect(context.readTools).not.toContain("get_skill");
    expect(context.readTools).toContain("get_task");
    expect(context.writeTools).toEqual([]);
    expect(context.primarySupportsImages).toBe(false);
  });

  it("offers jev_assess only when the registry resolves a key for the project", async () => {
    seedJev();

    const jevConfig = await resolveWorkerJevConfig(base(), "p1");
    expect(jevConfig).toEqual({ apiKey: JEV_PLAINTEXT, baseUrl: JEV_BASE_URL, model: "jev-latest" });

    const context = await resolveWorkerTurnContext({ driver: driver(), base: base() }, "p1");
    expect(context.readTools).toContain("jev_assess");
    expect(context.jevConfigured).toBe(true);
  });
});

describe("resolveWorkerJevConfig fail-open", () => {
  it("returns null (no throw) when the stored key cannot be opened", async () => {
    seedJev();
    // No master key in the env: the keyring gate fails open rather than
    // breaking the turn.
    const missingKey = { } as RuntimeEnv;
    await expect(resolveWorkerJevConfig(base(missingKey), "p1")).resolves.toBeNull();
  });

  it("returns null when the project has not opted in", async () => {
    db.exec("UPDATE assistant_jev_config SET enabled = 1 WHERE id = 'default'");
    db.prepare(
      `INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', ?, ?, ?, 'test')`
    ).run(jevSeed.ciphertext, jevSeed.iv, jevSeed.keyId);
    // assistant_jev_projects left empty.
    await expect(resolveWorkerJevConfig(base(), "p1")).resolves.toBeNull();
  });
});

describe("buildWorkerReadToolExecutor dispatch", () => {
  // The executor builds its `Storage` layer eagerly; without a bucket the
  // fs fallback would construct at root "" and fail the whole data layer. The
  // production Worker always binds BLOB, so a stub stands in for tests (no
  // listed tool reads storage here).
  const NO_BLOB = { get: async () => null };
  const run = (name: string, args: Record<string, unknown>): Promise<ReadToolResponse> =>
    buildWorkerReadToolExecutor({ driver: driver(), base: base(), blob: NO_BLOB })({ name, args, projectId: "p1" });

  it("dispatches get_task through TaskRepo and returns the enriched task", async () => {
    seedBoard();
    const res = await run("get_task", { ref: "P-1" });

    expect(res.ok).toBe(true);
    const task = (res.result as { task: { key: string; title: string; markdown: string; columnName?: string } }).task;
    expect(task.key).toBe("P-1");
    expect(task.title).toBe("Fix login");
    expect(task.columnName).toBe("Todo");
  });

  it("dispatches get_board_structure and returns columns/swimlanes/milestones", async () => {
    seedBoard();
    const res = await run("get_board_structure", {});

    expect(res.ok).toBe(true);
    const board = res.result as { columns: Array<{ name: string }>; swimlanes: Array<{ name: string }>; milestones: unknown[] };
    expect(board.columns.map((c) => c.name)).toEqual(["Todo"]);
    expect(board.swimlanes.map((s) => s.name)).toEqual(["Backlog"]);
    expect(board.milestones).toEqual([]);
  });

  it("returns a typed error for an unknown tool", async () => {
    const res = await run("not_a_tool", {});
    expect(res).toEqual({ ok: false, error: "unknown read tool: not_a_tool" });
  });
});
