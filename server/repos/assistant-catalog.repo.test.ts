import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AssistantCatalogRepo } from "./assistant-catalog.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-catalog-repo-"));
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

function makeRepo(db: Database) {
  const layer = AssistantCatalogRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantCatalogRepo);
}

describe("AssistantCatalogRepo agents", () => {
  it("create/find/update/delete round-trip", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* repo.createAgent({ id: "a1", name: "A1", description: "d", instructions: "i" });
        expect(created.isBuiltin).toBe(false);
        expect(created.skillIds).toEqual([]);

        const updated = yield* repo.updateAgent("a1", { name: "A1 renamed" });
        expect(updated.name).toBe("A1 renamed");

        yield* repo.deleteAgent("a1");
        const err = yield* repo.findAgentById("a1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("replaceAgentSkills sets the junction, findAgentById exposes it", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createAgent({ id: "a1", name: "A1", description: "", instructions: "" });
        yield* repo.createSkill({ id: "s1", name: "S1", description: "", instructions: "" });
        yield* repo.createSkill({ id: "s2", name: "S2", description: "", instructions: "" });
        yield* repo.replaceAgentSkills("a1", ["s1", "s2"]);
        const agent = yield* repo.findAgentById("a1");
        expect([...agent.skillIds].sort()).toEqual(["s1", "s2"]);

        // Replace is destructive: the old set is gone.
        yield* repo.replaceAgentSkills("a1", ["s2"]);
        expect((yield* repo.findAgentById("a1")).skillIds).toEqual(["s2"]);
      })
    );
  });

  it("replaceAgentSkills duplicate skillIds rolls back, prior set unchanged", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createAgent({ id: "a1", name: "A1", description: "", instructions: "" });
        yield* repo.createSkill({ id: "s1", name: "S1", description: "", instructions: "" });
        yield* repo.createSkill({ id: "s2", name: "S2", description: "", instructions: "" });
        yield* repo.replaceAgentSkills("a1", ["s1", "s2"]);

        const dup = yield* Effect.either(repo.replaceAgentSkills("a1", ["s1", "s1"]));
        expect(dup._tag).toBe("Left");
        if (dup._tag === "Left") expect(dup.left._tag).toBe("ConstraintViolation");

        // The batch rolled back atomically — the DELETE did not survive.
        expect([...(yield* repo.findAgentById("a1")).skillIds].sort()).toEqual(["s1", "s2"]);
      })
    );
  });

  it("lists agents with builtins first", async () => {
    const repo = makeRepo(db);
    db.exec("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('assistant', 'Assistant Agent', '', '', 1)");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.createAgent({ id: "custom", name: "Custom", description: "", instructions: "" });
        const agents = yield* repo.listAgents();
        expect(agents[0]!.id).toBe("assistant");
        expect(agents.map((a) => a.id)).toContain("custom");
      })
    );
  });

  it("deleting a missing agent fails RowNotFound", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.deleteAgent("ghost").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("AssistantCatalogRepo skills", () => {
  it("create/find/update/delete round-trip", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* repo.createSkill({ id: "s1", name: "S1", description: "d", instructions: "i" });
        expect(created.isBuiltin).toBe(false);

        const updated = yield* repo.updateSkill("s1", { instructions: "new" });
        expect(updated.instructions).toBe("new");

        yield* repo.deleteSkill("s1");
        const err = yield* repo.findSkillById("s1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("lists builtin skills", async () => {
    const repo = makeRepo(db);
    db.exec("INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('requirements', 'Requirements', '', '', 1)");
    await Effect.runPromise(
      Effect.gen(function* () {
        const skills = yield* repo.listSkills();
        expect(skills.some((s) => s.isBuiltin)).toBe(true);
      })
    );
  });
});
