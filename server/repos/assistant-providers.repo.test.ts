import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { AssistantProvidersRepo } from "./assistant-providers.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AssistantProvidersRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-providers-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantProvidersRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AssistantProvidersRepo);
}

const KEY = "sk-super-secret-1234";

describe("AssistantProvidersRepo", () => {
  it("create / getById / list / update happy path", async () => {
    setup();
    const created = await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test", apiKey: KEY }));
    expect(created.id).toBe("pr1");
    expect(created.api_key).toBe(KEY);

    const found = await Effect.runPromise(repo.getById("pr1"));
    expect(found.base_url).toBe("https://api.test");

    const all = await Effect.runPromise(repo.list());
    expect(all.map((p) => p.id)).toEqual(["pr1"]);

    const updated = await Effect.runPromise(repo.update("pr1", { label: "OpenAI v2", baseUrl: "https://api2.test", apiKey: "sk-rotated-9999" }));
    expect(updated.label).toBe("OpenAI v2");
    expect(updated.base_url).toBe("https://api2.test");
    expect(updated.api_key).toBe("sk-rotated-9999");
  });

  it("update with no fields returns the current row", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test", apiKey: KEY }));
    const unchanged = await Effect.runPromise(repo.update("pr1", {}));
    expect(unchanged.label).toBe("OpenAI");
    expect(unchanged.api_key).toBe(KEY);
  });

  it("maskedView never returns the raw key and attaches ordered models", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test", apiKey: KEY }));
    db.exec(`INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled)
             VALUES ('m2','pr1','gpt-b','openai_compatible',2,1),
                    ('m1','pr1','gpt-a','openai_compatible',1,0)`);

    const view = await Effect.runPromise(repo.maskedView("pr1"));
    expect(view.hasKey).toBe(true);
    expect(view.keyMask).toBe("sk-…1234");
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.models?.map((m) => m.modelId)).toEqual(["gpt-a", "gpt-b"]);
    expect(view.models?.map((m) => m.enabled)).toEqual([false, true]);
  });

  it("maskedList masks every key and omits the raw secrets", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "A", baseUrl: "https://a.test", apiKey: "sk-aaaa-1111" }));
    await Effect.runPromise(repo.create({ id: "pr2", label: "B", baseUrl: "https://b.test", apiKey: "sk-bbbb-2222" }));
    db.exec(`UPDATE assistant_providers SET created_at = '2026-01-01 00:00:00' WHERE id = 'pr1'`);
    db.exec(`UPDATE assistant_providers SET created_at = '2026-01-02 00:00:00' WHERE id = 'pr2'`);

    const list = await Effect.runPromise(repo.maskedList());
    expect(list.map((p) => p.id)).toEqual(["pr1", "pr2"]);
    for (const p of list) expect(p.hasKey).toBe(true);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("sk-aaaa-1111");
    expect(serialized).not.toContain("sk-bbbb-2222");
  });

  it("duplicate id → ConstraintViolation; unknown maskedView → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "A", baseUrl: "https://a.test", apiKey: KEY }));
    const dup = await Effect.runPromise(Effect.either(repo.create({ id: "pr1", label: "B", baseUrl: "https://b.test", apiKey: "sk-x" })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const missing = await Effect.runPromise(Effect.either(repo.maskedView("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });
});
