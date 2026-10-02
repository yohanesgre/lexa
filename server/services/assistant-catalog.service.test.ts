import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AssistantCatalogService, ASSISTANT_AGENT } from "./assistant-catalog.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-catalog-svc-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});

function seedDefaultSkills(): void {
  for (const id of ASSISTANT_AGENT.skillIds) {
    db.prepare("INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES (?, ?, '', '', 1)").run(id, id);
  }
}

function makeService(db: Database) {
  const layer = AssistantCatalogService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantCatalogService);
}

describe("AssistantCatalogService.resetAgentToDefault", () => {
  it("restores instructions and replaces the skill set in one batch", async () => {
    seedDefaultSkills();
    db.prepare("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES (?, 'Assistant Agent', '', 'custom drift', 1)").run(ASSISTANT_AGENT.id);
    db.prepare("INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES (?, 'requirements')").run(ASSISTANT_AGENT.id);
    const svc = makeService(db);

    const agent = await Effect.runPromise(svc.resetAgentToDefault(ASSISTANT_AGENT.id));
    expect(agent.instructions).toBe(ASSISTANT_AGENT.instructions);
    expect([...agent.skillIds].sort()).toEqual([...ASSISTANT_AGENT.skillIds].sort());
  });

  it("rolls the whole batch back when a replacement skill insert fails", async () => {
    seedDefaultSkills();
    db.prepare("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES (?, 'Assistant Agent', '', 'custom drift', 1)").run(ASSISTANT_AGENT.id);
    db.prepare("INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES (?, 'requirements')").run(ASSISTANT_AGENT.id);
    // One seeded default is missing → the FK on the junction insert fails,
    // rolling the instructions update and the junction delete back too.
    db.prepare("DELETE FROM lexa_skills WHERE id = 'polish'").run();
    const svc = makeService(db);

    const res = await Effect.runPromise(Effect.either(svc.resetAgentToDefault(ASSISTANT_AGENT.id)));
    expect(Either.isLeft(res)).toBe(true);

    const row = db.prepare("SELECT instructions FROM lexa_agents WHERE id = ?").get(ASSISTANT_AGENT.id) as { instructions: string };
    expect(row.instructions).toBe("custom drift");
    const skills = db.prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = ? ORDER BY skill_id").all(ASSISTANT_AGENT.id) as Array<{ skill_id: string }>;
    expect(skills.map((s) => s.skill_id)).toEqual(["requirements"]);
  });

  it("a non-builtin agent → AgentBuiltinDelete", async () => {
    db.prepare("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('custom', 'Custom', '', '', 0)").run();
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.resetAgentToDefault("custom")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left._tag).toBe("AgentBuiltinDelete");
  });
});
