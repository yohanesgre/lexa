import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { AssistantJevRepo, type JevSecretStorage } from "./assistant-jev.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AssistantJevRepo;

afterEach(() => {
  try { db?.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-jev-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantJevRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AssistantJevRepo);
}

const secret = (iv: string): JevSecretStorage => ({
  ciphertext: "cipher-" + iv,
  iv,
  keyId: "active",
  keyHint: "4c8e",
});

describe("AssistantJevRepo", () => {
  it("migration 0013 seeds the singleton config", async () => {
    setup();
    const row = await Effect.runPromise(repo.getConfig());
    expect(row).toMatchObject({
      id: "default",
      base_url: "https://api.typesafe.ai",
      model: "jev-latest",
      enabled: 0,
      secret_ciphertext: null,
      secret_iv: null,
      secret_key_id: null,
      secret_key_hint: null,
    });
  });

  it("updateConfig writes fields and bumps updated_at; an empty patch is a read", async () => {
    setup();
    db.exec(`UPDATE assistant_jev_config SET created_at = '2000-01-01 00:00:00', updated_at = '2000-01-01 00:00:00' WHERE id = 'default'`);

    const unchanged = await Effect.runPromise(repo.updateConfig({}));
    expect(unchanged.updated_at).toBe("2000-01-01 00:00:00");

    const updated = await Effect.runPromise(repo.updateConfig({ baseUrl: "https://jev.internal", model: "jev-x", enabled: true }));
    expect(updated.base_url).toBe("https://jev.internal");
    expect(updated.model).toBe("jev-x");
    expect(updated.enabled).toBe(1);
    expect(updated.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("putSecret upserts and rotates the IV; the LEFT JOIN surfaces it", async () => {
    setup();
    await Effect.runPromise(repo.putSecret(secret("iv-one")));
    let row = await Effect.runPromise(repo.getConfig());
    expect(row.secret_ciphertext).toBe("cipher-iv-one");
    expect(row.secret_iv).toBe("iv-one");
    expect(row.secret_key_id).toBe("active");
    expect(row.secret_key_hint).toBe("4c8e");

    await Effect.runPromise(repo.putSecret({ ...secret("iv-two"), keyId: "prev", keyHint: "9999" }));
    row = await Effect.runPromise(repo.getConfig());
    expect(row.secret_iv).toBe("iv-two");
    expect(row.secret_key_id).toBe("prev");
    expect(row.secret_key_hint).toBe("9999");
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_jev_secrets").get()).toEqual({ n: 1 });
  });

  it("deleteSecret removes the row and is keyless-safe when absent", async () => {
    setup();
    await Effect.runPromise(repo.putSecret(secret("iv-one")));
    await Effect.runPromise(repo.deleteSecret());
    const row = await Effect.runPromise(repo.getConfig());
    expect(row.secret_ciphertext).toBeNull();
    // A second delete on an empty table is a no-op, not an error.
    await Effect.runPromise(repo.deleteSecret());
  });

  it("getProject is null when absent; setProject upserts and bumps updated_at", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    expect(await Effect.runPromise(repo.getProject("p1"))).toBeNull();

    const created = await Effect.runPromise(repo.setProject("p1", true));
    expect(created).toMatchObject({ project_id: "p1", enabled: 1 });

    db.exec(`UPDATE assistant_jev_projects SET updated_at = '2000-01-01 00:00:00' WHERE project_id = 'p1'`);
    const updated = await Effect.runPromise(repo.setProject("p1", false));
    expect(updated.enabled).toBe(0);
    expect(updated.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_jev_projects").get()).toEqual({ n: 1 });
  });
});
