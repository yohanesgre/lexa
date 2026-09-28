import { describe, expect, it, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate";
import { runBootBackfill } from "./provider-secrets-boot";
import type { RuntimeEnv } from "../env";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const MASTER_KEY = Buffer.from("z".repeat(32)).toString("base64");

let dirs: string[] = [];

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lexa-provider-backfill-boot-"));
  dirs.push(dir);
  const dbPath = join(dir, "app.db");
  runMigrations(dbPath, MIGRATIONS);
  return dbPath;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runBootBackfill (Bun boot wiring)", () => {
  it("resolves on an empty DB without throwing AsyncFiberException", async () => {
    const dbPath = freshDbPath();
    await expect(runBootBackfill(dbPath, { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv)).resolves.toEqual({
      encrypted: 0,
      cleared: 0,
      blocked: 0,
    });
  });

  it("encrypts + clears a populated DB and resolves", async () => {
    const dbPath = freshDbPath();
    const db = new Database(dbPath);
    db.exec(`INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1', 'P', 'https://x', 'sk-boot-4242')`);
    db.close();

    const report = await runBootBackfill(dbPath, { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv);
    expect(report).toEqual({ encrypted: 1, cleared: 1, blocked: 0 });

    const check = new Database(dbPath);
    const legacy = check.prepare("SELECT api_key FROM assistant_providers WHERE id = 'pr1'").get() as { api_key: string };
    expect(legacy.api_key).toBe("");
    const secret = check.prepare("SELECT key_hint FROM assistant_provider_secrets WHERE provider_id = 'pr1'").get() as { key_hint: string };
    expect(secret.key_hint).toBe("4242");
    check.close();
  });
});
