import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, RowNotFound, ConstraintViolation } from "../db/database";
import { DbBunLive } from "../db/db";
import { WorkspaceInvitesService, InviteAlreadyPending, InviteNotFound } from "./workspace-invites.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-invites-"));
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


function makeService(db: Database) {
  const layer = WorkspaceInvitesService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WorkspaceInvitesService);
}

describe("WorkspaceInvitesService", () => {
  beforeEach(() => {
    // The password-link suite below sets a different process-env origin once
    // per file; this suite asserts the canonical dev fallback.
    process.env.LXK_PUBLIC_URL = "http://localhost:5173";
  });

  it("creates an invite with a 7d expiry and a link carrying the token", async () => {
    const svc = makeService(db);
    const { invite, link } = await Effect.runPromise(svc.create("New.User@Lexa.Dev", null));
    expect(invite.email).toBe("new.user@lexa.dev");
    expect(invite.acceptedAt).toBeNull();
    expect(invite.tokenHint).toHaveLength(8);
    expect(invite.expiresAt).toBeTruthy();
    const expiryMs = new Date(invite.expiresAt).getTime();
    expect(expiryMs - Date.now()).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);
    expect(expiryMs - Date.now()).toBeLessThan(7 * 24 * 3600 * 1000 + 60_000);
    expect(link).toMatch(/^http:\/\/localhost:5173\/invite\?token=/);
    const token = link.split("token=")[1]!;
    const row = db.prepare("SELECT token FROM workspace_invitations WHERE email = ?").get("new.user@lexa.dev") as { token: string } | null;
    expect(row?.token).toBe(token);
    expect(invite.tokenHint).toBe(token!.slice(0, 8));
  });

  it("rejects a duplicate pending invite for the same email", async () => {
    const svc = makeService(db);
    await Effect.runPromise(svc.create("a@lexa.dev", null));
    const result = await Effect.runPromise(Effect.either(svc.create("A@Lexa.Dev", null)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InviteAlreadyPending);
  });

  it("re-issues when the previous invite expired (dead rows do not block)", async () => {
    const svc = makeService(db);
    const first = await Effect.runPromise(svc.create("a@lexa.dev", null));
    db.prepare("UPDATE workspace_invitations SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') WHERE id = ?").run(first!.invite.id);
    const second = await Effect.runPromise(Effect.either(svc.create("a@lexa.dev", null)));
    expect(Either.isRight(second)).toBe(true);
    if (Either.isRight(second)) expect(second.right.invite.email).toBe("a@lexa.dev");
  });

  it("revokes a pending invite and refuses unknown ids", async () => {
    const svc = makeService(db);
    const { invite } = await Effect.runPromise(svc.create("a@lexa.dev", null));
    expect(await Effect.runPromise(Effect.either(svc.revoke(invite.id)))).toEqual(Either.right(undefined));
    const gone = db.prepare("SELECT id FROM workspace_invitations WHERE id = ?").get(invite.id);
    expect(gone).toBeNull();
    const second = await Effect.runPromise(Effect.either(svc.revoke(invite.id)));
    expect(Either.isLeft(second)).toBe(true);
    if (Either.isLeft(second)) expect(second.left).toBeInstanceOf(InviteNotFound);
  });

  it("refuses to revoke an accepted invite (spent)", async () => {
    const svc = makeService(db);
    const { invite } = await Effect.runPromise(svc.create("a@lexa.dev", null));
    db.prepare("UPDATE workspace_invitations SET accepted_at = datetime('now') WHERE id = ?").run(invite.id);
    const result = await Effect.runPromise(Effect.either(svc.revoke(invite.id)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ConstraintViolation);
    const stillThere = db.prepare("SELECT id FROM workspace_invitations WHERE id = ?").get(invite.id);
    expect(stillThere).toBeTruthy();
  });

});

// Carried from the absorbed server/services/password-links.service.test.ts
// (single-use credential issuance): its own DATABASE_PATH-bound db, since
// server/auth.ts binds its DB at import time.
let pwDir: string;
let dbPath: string;

beforeAll(async () => {
  pwDir = mkdtempSync(join(tmpdir(), "lexa-pwlinks-"));
  dbPath = join(pwDir, "test.db");
  const { runMigrations } = await import("../db/migrate");
  runMigrations(dbPath, MIGRATIONS);
  // server/auth.ts binds its DB at import time — point it at THIS db before
  // any import of the auth chain (service imports PUBLIC_URL from ../auth).
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
});

afterAll(() => {
  rmSync(pwDir, { recursive: true, force: true });
});

describe("PasswordLinksService", () => {
  beforeEach(() => {
    process.env.LXK_PUBLIC_URL = "http://localhost:3000";
  });

  it("issues a set-password link (verification row, 7d expiry) and the native reset consumes it once", async () => {
    // The static WorkspaceInvitesService import above already evaluated
    // ../auth with the default PUBLIC_URL (5173); reset the registry so this
    // test's auth re-binds PUBLIC_URL from the 3000 env set in beforeAll.
    vi.resetModules();
    const { auth } = await import("../auth");
    const { PasswordLinksService } = await import("./password-links.service");
    const { initSqlite, Sqlite } = await import("../db/database");

    const created = await auth.api.createUser({
      body: { email: "legacy@lexa.dev", password: "oldpass123", name: "Legacy", data: { role: "member" } },
    });
    const userId = created.user.id;

    const db = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
    const sqlite = Context.get(db, Sqlite);
    const layer = PasswordLinksService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, sqlite), DbBunLive(sqlite))));
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    const svc = Context.get(ctx, PasswordLinksService);

    const { token, link } = await Effect.runPromise(svc.issue(userId));
    expect(link).toBe(`http://localhost:3000/set-password?token=${token}`);
    const row = sqlite.prepare("SELECT identifier, value, expiresAt FROM verification WHERE identifier = ?").get(`reset-password:${token}`) as { identifier: string; value: string; expiresAt: string } | null;
    expect(row?.value).toBe(userId);
    const expiryMs = new Date(row!.expiresAt).getTime();
    expect(expiryMs - Date.now()).toBeGreaterThan(7 * 24 * 3600 * 1000 - 60_000);

    // Consume via the native endpoint (keyless): POST /api/auth/reset-password
    const consume = (body: unknown) =>
      auth.handler(new Request("http://localhost:3000/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    const first = await consume({ token, newPassword: "brandnew123" });
    expect(first.status).toBe(200);
    // Successful reset expires the requester's own signed session cookies in
    // the same response (native deletes DB sessions; the hook clears cookies),
    // so the next browser state is signed out without touching other sessions.
    const cleared = first.headers.getSetCookie();
    const expiredCookie = (name: string) =>
      cleared.some((c) => c.startsWith(`${name}=`) && /max-age=0/i.test(c));
    expect(expiredCookie("better-auth.session_token")).toBe(true);
    expect(expiredCookie("better-auth.session_data")).toBe(true);

    const signIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "brandnew123" } });
    expect(signIn.user.email).toBe("legacy@lexa.dev");

    // Single-use: the same token is dead.
    const second = await consume({ token, newPassword: "another123" });
    expect(second.status).toBe(400);

    // The old password no longer works.
    const oldSignIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "oldpass123" } }).catch((e) => e);
    expect((oldSignIn as { status?: number }).status ?? 200).not.toBe(200);

    // A token issued while active must not complete after deactivation: the
    // before-guard rejects with the existing INVALID_TOKEN shape and does not
    // mutate the credential or consume the token.
    const extra = await Effect.runPromise(svc.issue(userId));
    sqlite.prepare("UPDATE users SET banned = 1 WHERE id = ?").run(userId);
    const bannedAttempt = await consume({ token: extra.token, newPassword: "banned123" });
    expect(bannedAttempt.status).toBe(400);
    expect(((await bannedAttempt.json()) as { code?: string }).code).toBe("INVALID_TOKEN");
    const bannedViaQuery = await auth.handler(new Request(
      `http://localhost:3000/api/auth/reset-password?token=${encodeURIComponent(extra.token)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newPassword: "banned123" }) }
    ));
    expect(bannedViaQuery.status).toBe(400);
    const stillIssued = sqlite
      .prepare("SELECT value FROM verification WHERE identifier = ?")
      .get(`reset-password:${extra.token}`) as { value: string } | null;
    expect(stillIssued?.value).toBe(userId);

    // Reactivate only to prove the credential hash was untouched by the
    // rejected attempts: the post-first-reset password still signs in and the
    // attempted replacement does not.
    sqlite.prepare("UPDATE users SET banned = 0 WHERE id = ?").run(userId);
    const unchangedSignIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "brandnew123" } });
    expect(unchangedSignIn.user.email).toBe("legacy@lexa.dev");
    const attemptedSignIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "banned123" } }).catch((e) => e);
    expect((attemptedSignIn as { status?: number }).status ?? 200).not.toBe(200);

    sqlite.close();
  });

  it("refuses to issue for an unknown user", async () => {
    const { PasswordLinksService } = await import("./password-links.service");
    const { initSqlite, Sqlite, RowNotFound } = await import("../db/database");
    const db = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
    const sqlite = Context.get(db, Sqlite);
    const layer = PasswordLinksService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, sqlite), DbBunLive(sqlite))));
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    const svc = Context.get(ctx, PasswordLinksService);
    const result = await Effect.runPromise(Effect.either(svc.issue("no-such-user")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
    sqlite.close();
  });
});
