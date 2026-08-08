import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { resolveApiKeyIdentity } from "./auth-key";
import { actorFromIdentity } from "./auth";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const RAW_KEY = "lxk_" + "k".repeat(43);
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lexa-auth-key-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  dbs.push(db);
  return { db, path };
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("resolveApiKeyIdentity", () => {
  it("returns keyName and resolves x-lxk-user to a user", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, NULL)").run(KEY_HASH);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member')").run();
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers({ "x-lxk-user": "maria@lexa.test" }), db, path);
    expect(res).not.toBeNull();
    expect(res!.keyId).toBe("k1");
    expect(res!.keyName).toBe("opencode-local");
    expect(res!.userId).toBe("u1");
    expect(res!.userName).toBe("Maria");
  });

  it("keeps role from the key, never from the header", () => {
    // unowned key → admin; header must not change role even though it
    // names a member user.
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, NULL)").run(KEY_HASH);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member')").run();
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers({ "x-lxk-user": "maria@lexa.test" }), db, path);
    expect(res!.role).toBe("admin");
  });

  it("without the header keeps the key owner as the actor", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, 'u1')").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers(), db, path);
    expect(res!.userId).toBe("u1");
    expect(res!.userName).toBeNull();
    expect(res!.role).toBe("member");
  });

  it("creates the user when the header names an unknown email", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, NULL)").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers({ "x-lxk-user": "new@lexa.test" }), db, path);
    expect(res!.userName).toBe("new");
    const created = db.prepare("SELECT id FROM users WHERE email = 'new@lexa.test'").get() as { id: string } | undefined;
    expect(created?.id).toBe(res!.userId);
  });

  it("returns null for an unknown key", () => {
    const { db, path } = tmpDb();
    expect(resolveApiKeyIdentity("Bearer lxk_" + "z".repeat(43), new Headers(), db, path)).toBeNull();
  });

  it("ignores malformed Authorization headers", () => {
    const { db, path } = tmpDb();
    expect(resolveApiKeyIdentity("Basic abc", new Headers(), db, path)).toBeNull();
    expect(resolveApiKeyIdentity("Bearer notlxk_short", new Headers(), db, path)).toBeNull();
  });
});

describe("actorFromIdentity", () => {
  it("user identity → user actor with userName label", () => {
    expect(actorFromIdentity({ keyId: "k1", keyName: "opencode-local", userId: "u1", userName: "Maria", role: "member" })).toEqual({ kind: "user", label: "Maria", userId: "u1" });
  });

  it("agent identity → agent actor with keyName label", () => {
    expect(actorFromIdentity({ keyId: "k1", keyName: "opencode-local", userId: null, userName: null, role: "admin" })).toEqual({ kind: "agent", label: "opencode-local", userId: null });
  });
});
