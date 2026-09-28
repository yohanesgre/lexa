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

const SECRET = {
  ciphertext: "Y2lwaGVy",
  iv: "aXZpdml2aXZpdg",
  keyId: "active",
  keyHint: "9f3a",
};

describe("AssistantProvidersRepo", () => {
  it("create stores '' in the dead api_key column and round-trips label/baseUrl", async () => {
    setup();
    const created = await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test" }));
    expect(created.id).toBe("pr1");
    expect(created.secret_ciphertext).toBeNull();

    const found = await Effect.runPromise(repo.getById("pr1"));
    expect(found.base_url).toBe("https://api.test");

    const all = await Effect.runPromise(repo.list());
    expect(all.map((p) => p.id)).toEqual(["pr1"]);
    // The legacy column is dead: created rows carry ''.
    const raw = db.prepare("SELECT api_key FROM assistant_providers WHERE id = 'pr1'").get() as { api_key: string };
    expect(raw.api_key).toBe("");

    const updated = await Effect.runPromise(repo.update("pr1", { label: "OpenAI v2", baseUrl: "https://api2.test" }));
    expect(updated.label).toBe("OpenAI v2");
    expect(updated.base_url).toBe("https://api2.test");
    // The UPDATE never names api_key.
    const rawAfter = db.prepare("SELECT api_key FROM assistant_providers WHERE id = 'pr1'").get() as { api_key: string };
    expect(rawAfter.api_key).toBe("");
  });

  it("update with no fields returns the current row", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test" }));
    const unchanged = await Effect.runPromise(repo.update("pr1", {}));
    expect(unchanged.label).toBe("OpenAI");
    expect(unchanged.secret_ciphertext).toBeNull();
  });

  it("putSecret exposes the hint through maskedView and never the ciphertext", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.test" }));
    db.exec(`INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled)
             VALUES ('m2','pr1','gpt-b','openai_compatible',2,1),
                    ('m1','pr1','gpt-a','openai_compatible',1,0)`);
    await Effect.runPromise(repo.putSecret("pr1", SECRET));

    const view = await Effect.runPromise(repo.maskedView("pr1"));
    expect(view.hasKey).toBe(true);
    expect(view.keyMask).toBe("sk-…9f3a");
    expect(JSON.stringify(view)).not.toContain(SECRET.ciphertext);
    expect(view.models?.map((m) => m.modelId)).toEqual(["gpt-a", "gpt-b"]);
    expect(view.models?.map((m) => m.enabled)).toEqual([false, true]);
  });

  it("maskedList masks every key and omits the raw secrets", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "A", baseUrl: "https://a.test" }));
    await Effect.runPromise(repo.create({ id: "pr2", label: "B", baseUrl: "https://b.test" }));
    await Effect.runPromise(repo.putSecret("pr1", { ...SECRET, keyHint: "1111" }));
    await Effect.runPromise(repo.putSecret("pr2", { ...SECRET, keyHint: "2222" }));
    db.exec(`UPDATE assistant_providers SET created_at = '2026-01-01 00:00:00' WHERE id = 'pr1'`);
    db.exec(`UPDATE assistant_providers SET created_at = '2026-01-02 00:00:00' WHERE id = 'pr2'`);

    const list = await Effect.runPromise(repo.maskedList());
    expect(list.map((p) => p.id)).toEqual(["pr1", "pr2"]);
    expect(list.map((p) => p.keyMask)).toEqual(["sk-…1111", "sk-…2222"]);
    for (const p of list) expect(p.hasKey).toBe(true);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(SECRET.ciphertext);
    expect(serialized).not.toContain(SECRET.iv);
  });

  it("deleteSecret works keylessly; remove deletes the child first", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "A", baseUrl: "https://a.test" }));
    await Effect.runPromise(repo.putSecret("pr1", SECRET));
    await Effect.runPromise(repo.deleteSecret("pr1"));
    expect((await Effect.runPromise(repo.maskedView("pr1"))).hasKey).toBe(false);

    await Effect.runPromise(repo.putSecret("pr1", SECRET));
    await Effect.runPromise(repo.remove("pr1"));
    const children = db.prepare("SELECT COUNT(*) AS n FROM assistant_provider_secrets WHERE provider_id = 'pr1'").get() as { n: number };
    expect(children.n).toBe(0);
  });

  it("duplicate id → ConstraintViolation; unknown maskedView / remove → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "pr1", label: "A", baseUrl: "https://a.test" }));
    const dup = await Effect.runPromise(Effect.either(repo.create({ id: "pr1", label: "B", baseUrl: "https://b.test" })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const missing = await Effect.runPromise(Effect.either(repo.maskedView("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });

    const removed = await Effect.runPromise(Effect.either(repo.remove("nope")));
    expect(removed).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });
});
