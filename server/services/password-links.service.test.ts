import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-pwlinks-"));
  dbPath = join(dir, "test.db");
  const { runMigrations } = await import("../db/migrate");
  runMigrations(dbPath, MIGRATIONS);
  // server/auth.ts binds its DB at import time — point it at THIS db before
  // any import of the auth chain (service imports PUBLIC_URL from ../auth).
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PasswordLinksService", () => {
  it("issues a set-password link (verification row, 7d expiry) and the native reset consumes it once", async () => {
    const { auth } = await import("../auth");
    const { PasswordLinksService } = await import("./password-links.service");
    const { initSqlite, Sqlite } = await import("../db/database");

    const created = await auth.api.createUser({
      body: { email: "legacy@lexa.dev", password: "oldpass123", name: "Legacy", data: { role: "member" } },
    });
    const userId = created.user.id;

    const db = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
    const sqlite = Context.get(db, Sqlite);
    const layer = PasswordLinksService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, sqlite)));
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    const svc = Context.get(ctx, PasswordLinksService);

    const { token, link } = Effect.runSync(svc.issue(userId));
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

    const signIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "brandnew123" } });
    expect(signIn.user.email).toBe("legacy@lexa.dev");

    // Single-use: the same token is dead.
    const second = await consume({ token, newPassword: "another123" });
    expect(second.status).toBe(400);

    // The old password no longer works.
    const oldSignIn = await auth.api.signInEmail({ body: { email: "legacy@lexa.dev", password: "oldpass123" } }).catch((e) => e);
    expect((oldSignIn as { status?: number }).status ?? 200).not.toBe(200);

    sqlite.close();
  });

  it("refuses to issue for an unknown user", async () => {
    const { PasswordLinksService } = await import("./password-links.service");
    const { initSqlite, Sqlite, RowNotFound } = await import("../db/database");
    const db = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
    const sqlite = Context.get(db, Sqlite);
    const layer = PasswordLinksService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, sqlite)));
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    const svc = Context.get(ctx, PasswordLinksService);
    const result = Effect.runSync(Effect.either(svc.issue("no-such-user")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
    sqlite.close();
  });
});
