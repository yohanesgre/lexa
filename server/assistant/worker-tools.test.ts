// Worker-side read-tool executor + per-turn gating (ADR-0003 §B.5/§D, P3 WS3).
//
// `worker-tools.ts` is the Worker half of the DO tool path: it resolves the
// project's `assistant_settings`, bound skills and Jev config for one turn, and
// executes the read tools through the same `buildAssistantTools` the Bun path
// uses. These tests drive it against a real bun-sqlite database (migrations
// applied) with the same `Db | RuntimeEnv` base layer `workers-entry.ts` wires
// per request, so the SQL and the layer composition — not just the pure
// helpers — are exercised.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// H1 carry-over: pin the Jev preflight seam so a `mode: "resume"` turn can be
// proven to skip it (the real call is a network round trip).
vi.mock("./jev", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jev")>();
  return {
    ...actual,
    runJevPreflight: vi.fn(async () => ({ segment: "JEV-ADVISORY" })),
  };
});
import {
  buildWorkerReadToolExecutor,
  buildWorkerWriteToolExecutor,
  resolveWorkerHarnessContext,
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
  db.exec("DELETE FROM settings WHERE key = 'assistant_delegation_enabled'");
  // Document runs now reference lexa_agents/lexa_skills, so clear them first.
  db.exec("DELETE FROM assistant_tasks");
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

describe("resolveWorkerHarnessContext", () => {
  it("returns a redacted chat bundle: booleans + names, never the key/allowlist", async () => {
    seedSettings({ searchApiKey: "exa-secret", writeTools: "create_task" });
    const context = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "chat:c1", userText: "hi", mode: "turn" }
    );
    expect(context.documentType).toBe("chat");
    expect(context.hasSearchKey).toBe(true);
    expect(context.jevConfigured).toBe(false);
    expect(context.writeTools).toEqual(["create_task"]);
    expect(context.repoContent).toEqual([]);
    expect(context.mentionContext).toBeNull();
    expect(context.mcpTools).toEqual([]);
    // Dark launch: the global flag is absent, so delegation defaults off.
    expect(context.delegation).toEqual({ enabled: false, maxConcurrentRuns: 3 });
    const raw = JSON.stringify(context);
    expect(raw).not.toContain("exa-secret");
    expect(raw).not.toContain("searchApiKey");
    expect(raw).not.toContain("urlAllowlist");
  });

  it("enables delegation only when the global assistant_delegation_enabled setting is on", async () => {
    seedSettings();
    const off = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "chat:c1", userText: "hi", mode: "turn" }
    );
    expect(off.delegation.enabled).toBe(false);

    db.prepare("INSERT INTO settings (key, value) VALUES ('assistant_delegation_enabled', '1')").run();
    const on = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "chat:c1", userText: "hi", mode: "turn" }
    );
    expect(on.delegation).toEqual({ enabled: true, maxConcurrentRuns: 3 });
  });

  it("assembles a task bundle: doc context + the RUN row's skill markdown", async () => {
    seedSettings();
    seedBoard();
    seedBoundSkill();
    db.exec(
      `INSERT INTO assistant_threads (document_type, document_id, project_id, agent_id, skill_id, messages)
       VALUES ('task', 't1', 'p1', 'assistant', NULL, '[]')`
    );
    db.exec(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status)
       VALUES ('run-1', 'p1', 'task', 't1', 'assistant', 'sk', 'running')`
    );
    db.prepare("UPDATE tasks SET description = ? WHERE id = 't1'").run(
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Repro steps here" }] }],
      })
    );

    const context = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "task:t1", runId: "run-1", userText: "help with this", mode: "turn" }
    );
    expect(context.documentType).toBe("task");
    expect(context.agent?.id).toBe("assistant");
    expect(context.docContext).toContain("Task: P-1 — Fix login");
    expect(context.docContext).toContain("Repro steps here");
    expect(context.skillMarkdowns[0]).toContain("## Skill: Test Skill");
    // Chat-only blocks stay empty on a document thread.
    expect(context.mentionContext).toBeNull();
  });

  it("ignores a stale thread skill when the run carries no skill (auto mode)", async () => {
    seedSettings();
    seedBoard();
    seedBoundSkill();
    db.exec(
      `INSERT INTO assistant_threads (document_type, document_id, project_id, agent_id, skill_id, messages)
       VALUES ('task', 't1', 'p1', 'assistant', 'sk', '[]')`
    );
    db.exec(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status)
       VALUES ('run-auto', 'p1', 'task', 't1', 'assistant', NULL, 'running')`
    );

    const context = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "task:t1", runId: "run-auto", userText: "help with this", mode: "turn" }
    );
    expect(context.skillMarkdowns).toEqual([]);
  });

  it("keeps explicit $name tokens working on a document run with no run skill", async () => {
    seedSettings();
    seedBoard();
    seedBoundSkill();
    db.exec(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status)
       VALUES ('run-auto', 'p1', 'task', 't1', 'assistant', NULL, 'running')`
    );

    const context = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "task:t1", runId: "run-auto", userText: "please $test-skill this", mode: "turn" }
    );
    expect(context.skillMarkdowns[0]).toContain("## Skill: Test Skill");
  });

  it("skips the Jev preflight on mode:resume (and runs it on mode:turn)", async () => {
    seedJev();
    const turn = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "chat:c1", userText: "hi", mode: "turn" }
    );
    expect(turn.advisory).toBe("JEV-ADVISORY");
    const resume = await resolveWorkerHarnessContext(
      { driver: driver(), base: base() },
      { projectId: "p1", threadKey: "chat:c1", userText: "hi", mode: "resume" }
    );
    expect(resume.advisory).toBeNull();
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

  it("fails a prefixed mcp__ call open when MCP is not configured", async () => {
    const res = await run("mcp__srv__read", { q: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown MCP tool mcp__srv__read");
  });
});

describe("buildWorkerWriteToolExecutor (auto mode, D4)", () => {
  const exec = (name: string, args: Record<string, unknown>, ownerUserId = "u1") =>
    buildWorkerWriteToolExecutor({ base: base() })({ name, args, projectId: "p1", ownerUserId });

  // The auto path runs the full authz gate; a project grant is required for a
  // non-superadmin owner. Uses the `user_project_roles` grant (decision order 2)
  // so the test does not depend on team membership.
  function grantAccess(userId = "u1"): void {
    db.prepare("INSERT OR IGNORE INTO users (id, email, name, role) VALUES (?, ?, ?, 'member')").run(
      userId,
      `${userId}@test.dev`,
      userId
    );
    db.prepare("INSERT OR IGNORE INTO user_project_roles (user_id, role, project_id) VALUES (?, 'member', 'p1')").run(userId);
  }

  it("applies a write immediately and returns the applied result", async () => {
    seedBoard();
    grantAccess();
    const res = await exec("update_task", { ref: "P-1", title: "New title" });
    expect(res.ok).toBe(true);
    expect((res as { applied?: boolean }).applied).toBe(true);
    const task = db.prepare("SELECT title FROM tasks WHERE id = 't1'").get() as { title: string };
    expect(task.title).toBe("New title");
  });

  it("returns partial counts for a partially-applied bulk write", async () => {
    seedBoard();
    grantAccess();
    const res = await exec("archive_task", { refs: ["P-1", "NOPE"] });
    expect(res.ok).toBe(true);
    expect((res as { applied?: boolean }).applied).toBe(true);
    expect((res as { partial?: unknown }).partial).toEqual({
      applied: 1,
      failed: 1,
      errors: [expect.stringContaining("TASK_NOT_FOUND")],
    });
    const task = db.prepare("SELECT archived_at FROM tasks WHERE id = 't1'").get() as { archived_at: string | null };
    expect(task.archived_at).not.toBeNull();
  });

  it("fails a bulk write that applied zero items", async () => {
    seedBoard();
    grantAccess();
    const res = await exec("archive_task", { refs: ["NOPE-1", "NOPE-2"] });
    expect(res).toMatchObject({ ok: false, applied: false });
    expect((res as { error?: string }).error).toContain("TASK_NOT_FOUND");
  });

  it("maps an authz denial to a FORBIDDEN tool error", async () => {
    seedBoard();
    const res = await exec("update_task", { ref: "P-1", title: "x" });
    expect(res).toMatchObject({ ok: false, applied: false });
    expect((res as { error?: string }).error).toContain("FORBIDDEN");
  });
});
