import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { FieldConfigService } from "./field-config.service";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ProjectNotFound, OptionInUse, InvalidOption } from "../api/errors";
import type { FieldOption } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-fieldcfg-svc-"));
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


function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
}

function makeService(db: Database) {
  const layer = FieldConfigService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, FieldConfigService);
}

function makeRepo(db: Database) {
  const layer = FieldConfigRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, FieldConfigRepo);
}

const opt = (id: string, label: string, position = 0): FieldOption => ({ id, label, color: "#888", position });

describe("FieldConfigService.seedDefaults", () => {
  it("creates 4 priorities + 4 types; the first priority is the create default", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(repo.seedDefaults("p1"));
    const cfg = Effect.runSync(repo.findByProject("p1"));
    expect(cfg.priorities.map((o) => o.label)).toEqual(["Urgent", "High", "Medium", "Low"]);
    expect(cfg.types.map((o) => o.label)).toEqual(["Feature", "Bug", "Task", "Asset"]);
    const first = Effect.runSync(repo.findFirstPriority("p1"));
    expect(first?.label).toBe("Urgent");
    expect(first?.position).toBe(0);
  });
});

describe("FieldConfigService.findByProject", () => {
  it("unknown project → ProjectNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.findByProject("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("FieldConfigService.replace", () => {
  it("fully replaces both lists; id-less options are created with generated ids", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(makeRepo(db).seedDefaults("p1"));
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: [opt("", "Now"), opt("", "Later")],
        types: [opt("", "Chore")],
      }))
    );
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.priorities.map((o) => o.label)).toEqual(["Now", "Later"]);
      expect(res.right.priorities.map((o) => o.position)).toEqual([0, 1]);
      expect(res.right.priorities.every((o) => o.id !== "")).toBe(true);
      expect(res.right.types).toHaveLength(1);
      expect(res.right.types[0]!.position).toBe(0);
    }
    const rows = (db.prepare("SELECT COUNT(*) AS n FROM priority_options WHERE project_id = 'p1'").get() as { n: number }).n;
    expect(rows).toBe(2);
  });

  it("keeps existing ids, applies label/color edits and reorder; first option becomes the create default", () => {
    seed(db);
    const svc = makeService(db);
    const repo = makeRepo(db);
    Effect.runSync(repo.seedDefaults("p1"));
    const before = Effect.runSync(repo.findByProject("p1"));
    const [urgent, high] = before.priorities;
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: [
          { ...opt(high!.id, "High!!"), color: "#123456" },
          { ...opt(urgent!.id, "Urgent") },
        ],
        types: before.types,
      }))
    );
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.priorities.map((o) => o.label)).toEqual(["High!!", "Urgent"]);
      expect(res.right.priorities[0]!.color).toBe("#123456");
      expect(res.right.priorities[0]!.id).toBe(high!.id);
      expect(res.right.priorities.map((o) => o.position)).toEqual([0, 1]);
    }
    const first = Effect.runSync(repo.findFirstPriority("p1"));
    expect(first?.id).toBe(high!.id);
    expect(first?.label).toBe("High!!");
  });

  it("empty list → InvalidOption", () => {
    seed(db);
    const svc = makeService(db);
    const emptyPrios = Effect.runSync(Effect.either(svc.replace("p1", { priorities: [], types: [opt("", "T")] })));
    expect(Either.isLeft(emptyPrios)).toBe(true);
    if (Either.isLeft(emptyPrios)) expect(emptyPrios.left).toBeInstanceOf(InvalidOption);
    const emptyTypes = Effect.runSync(Effect.either(svc.replace("p1", { priorities: [opt("", "P")], types: [] })));
    expect(Either.isLeft(emptyTypes)).toBe(true);
    if (Either.isLeft(emptyTypes)) expect(emptyTypes.left).toBeInstanceOf(InvalidOption);
  });

  it("duplicate labels (case-insensitive) → InvalidOption", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: [opt("", "High"), opt("", "high")],
        types: [opt("", "T")],
      }))
    );
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(InvalidOption);
  });

  it("unknown option id → InvalidOption", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: [opt("does-not-exist", "P")],
        types: [opt("", "T")],
      }))
    );
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(InvalidOption);
      if (res.left instanceof InvalidOption) expect(res.left.optionId).toBe("does-not-exist");
    }
  });

  it("deleting an option used by tasks → OptionInUse", () => {
    seed(db);
    const svc = makeService(db);
    const repo = makeRepo(db);
    Effect.runSync(repo.seedDefaults("p1"));
    const cfg = Effect.runSync(repo.findByProject("p1"));
    const used = cfg.priorities[1]!;
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, priority, type, position, created_at) VALUES ('t1','p1','c1','s1','T', ?, ?, 'a0','2026-01-01 10:00:00')").run(used.id, cfg.types[0]!.id);
    const keptPrios = cfg.priorities.filter((o) => o.id !== used.id);
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", { priorities: keptPrios, types: cfg.types }))
    );
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) {
      expect(res.left).toBeInstanceOf(OptionInUse);
      if (res.left instanceof OptionInUse) {
        expect(res.left.optionId).toBe(used.id);
        expect(res.left.label).toBe(used.label);
      }
    }
    // the used option is still there
    const after = Effect.runSync(repo.findByProject("p1"));
    expect(after.priorities.map((o) => o.id)).toContain(used.id);
  });

  it("deleting an unused option succeeds", () => {
    seed(db);
    const svc = makeService(db);
    const repo = makeRepo(db);
    Effect.runSync(repo.seedDefaults("p1"));
    const cfg = Effect.runSync(repo.findByProject("p1"));
    const dropped = cfg.types[3]!;
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: cfg.priorities,
        types: cfg.types.filter((o) => o.id !== dropped.id),
      }))
    );
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) expect(res.right.types.map((o) => o.id)).not.toContain(dropped.id);
  });

  it("invalid payload leaves both lists untouched (atomicity)", () => {
    seed(db);
    const svc = makeService(db);
    const repo = makeRepo(db);
    Effect.runSync(repo.seedDefaults("p1"));
    const before = Effect.runSync(repo.findByProject("p1"));
    const res = Effect.runSync(
      Effect.either(svc.replace("p1", {
        priorities: [opt("", "Brand New")],
        types: [opt("nope", "T")], // invalid — the whole replace must fail
      }))
    );
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(InvalidOption);
    const after = Effect.runSync(repo.findByProject("p1"));
    expect(after.priorities.map((o) => o.label)).toEqual(before.priorities.map((o) => o.label));
    expect(after.types.map((o) => o.label)).toEqual(before.types.map((o) => o.label));
  });

  it("unknown project → ProjectNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.replace("nope", { priorities: [opt("", "P")], types: [opt("", "T")] })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });
});
