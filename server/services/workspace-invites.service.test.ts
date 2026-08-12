import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, RowNotFound, ConstraintViolation } from "../db/database";
import { WorkspaceInvitesService, InviteAlreadyPending, InviteNotFound } from "./workspace-invites.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-invites-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function makeService(db: Database) {
  const layer = WorkspaceInvitesService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WorkspaceInvitesService);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("WorkspaceInvitesService", () => {
  it("creates an invite with a 7d expiry and a link carrying the token", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const { invite, link } = Effect.runSync(svc.create("New.User@Lexa.Dev", null));
    expect(invite.email).toBe("new.user@lexa.dev");
    expect(invite.acceptedAt).toBeNull();
    expect(invite.tokenHint).toHaveLength(8);
    expect(invite.expiresAt).toBeTruthy();
    const expiryMs = new Date(invite.expiresAt).getTime();
    expect(expiryMs - Date.now()).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(expiryMs - Date.now()).toBeLessThan(7 * 24 * 3600 * 1000 + 60_000);
    expect(link).toMatch(/^http:\/\/localhost:3000\/invite\?token=/);
    const token = link.split("token=")[1];
    const row = db.prepare("SELECT token FROM workspace_invitations WHERE email = ?").get("new.user@lexa.dev") as { token: string } | null;
    expect(row?.token).toBe(token);
    expect(invite.tokenHint).toBe(token.slice(0, 8));
  });

  it("rejects a duplicate pending invite for the same email", () => {
    const db = tmpDb();
    const svc = makeService(db);
    Effect.runSync(svc.create("a@lexa.dev", null));
    const result = Effect.runSync(Effect.either(svc.create("A@Lexa.Dev", null)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InviteAlreadyPending);
  });

  it("re-issues when the previous invite expired (dead rows do not block)", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const first = Effect.runSync(svc.create("a@lexa.dev", null));
    db.prepare("UPDATE workspace_invitations SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') WHERE id = ?").run(first.invite.id);
    const second = Effect.runSync(Effect.either(svc.create("a@lexa.dev", null)));
    expect(Either.isRight(second)).toBe(true);
    if (Either.isRight(second)) expect(second.right.invite.email).toBe("a@lexa.dev");
  });

  it("revokes a pending invite and refuses unknown ids", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const { invite } = Effect.runSync(svc.create("a@lexa.dev", null));
    expect(Effect.runSync(Effect.either(svc.revoke(invite.id)))).toEqual(Either.right(undefined));
    const gone = db.prepare("SELECT id FROM workspace_invitations WHERE id = ?").get(invite.id);
    expect(gone).toBeNull();
    const second = Effect.runSync(Effect.either(svc.revoke(invite.id)));
    expect(Either.isLeft(second)).toBe(true);
    if (Either.isLeft(second)) expect(second.left).toBeInstanceOf(InviteNotFound);
  });

  it("refuses to revoke an accepted invite (spent)", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const { invite } = Effect.runSync(svc.create("a@lexa.dev", null));
    db.prepare("UPDATE workspace_invitations SET accepted_at = datetime('now') WHERE id = ?").run(invite.id);
    const result = Effect.runSync(Effect.either(svc.revoke(invite.id)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ConstraintViolation);
    const stillThere = db.prepare("SELECT id FROM workspace_invitations WHERE id = ?").get(invite.id);
    expect(stillThere).toBeTruthy();
  });

  it("lists invites newest first", () => {
    const db = tmpDb();
    const svc = makeService(db);
    Effect.runSync(svc.create("a@lexa.dev", null));
    Effect.runSync(svc.create("b@lexa.dev", null));
    const invites = Effect.runSync(svc.list());
    expect(invites.map((i) => i.email)).toEqual(["b@lexa.dev", "a@lexa.dev"]);
  });
});
