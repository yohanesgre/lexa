import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import type { auth as AuthInstance } from "../auth";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let dbPath: string;
let auth: typeof AuthInstance;

const accept = (body: unknown) =>
  auth.handler(new Request("http://localhost:3000/api/auth/invite/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

function seedInvite(email: string, opts: { expired?: boolean; accepted?: boolean } = {}): string {
  const db = new Database(dbPath);
  const token = `tok-${email}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = opts.expired
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO workspace_invitations (id, email, role, token, expires_at, created_by, accepted_at) VALUES (?, ?, 'member', ?, ?, NULL, ?)")
    .run(crypto.randomUUID(), email, token, expiresAt, opts.accepted ? new Date().toISOString() : null);
  db.close();
  return token;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-invite-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
  ({ auth } = await import("../auth"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const acceptCode = async (body: unknown): Promise<{ status: number; code?: string }> => {
  const res = await accept(body);
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
};

describe("POST /api/auth/invite/accept", () => {
  it("accepts a valid invite: creates a member account and stamps accepted_at", async () => {
    const token = seedInvite("invitee@lexa.dev");
    const res = await accept({ token, name: "Invitee", password: "password123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe("invitee@lexa.dev");
    const db = new Database(dbPath);
    const user = db.query("SELECT id, email, role FROM users WHERE email = 'invitee@lexa.dev'").get() as { id: string; email: string; role: string } | null;
    expect(user?.role).toBe("member");
    const acct = db.query("SELECT providerId, password FROM account WHERE userId = ?").get(user!.id) as { providerId: string; password: string } | null;
    expect(acct?.providerId).toBe("credential");
    expect(acct?.password).toBeTruthy();
    const row = db.query("SELECT accepted_at FROM workspace_invitations WHERE token = ?").get(token) as { accepted_at: string | null } | null;
    expect(row?.accepted_at).toBeTruthy();
    db.close();
    // the new member can log in with the chosen password
    const signIn = await auth.api.signInEmail({ body: { email: "invitee@lexa.dev", password: "password123" } });
    expect(signIn.user.email).toBe("invitee@lexa.dev");
  });

  it("rejects unknown, used, and expired tokens with INVALID_TOKEN", async () => {
    const unknown = await acceptCode({ token: "nope", name: "X", password: "password123" });
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("INVALID_TOKEN");

    const used = seedInvite("used@lexa.dev");
    await accept({ token: used, name: "Used", password: "password123" });
    const reuse = await acceptCode({ token: used, name: "Again", password: "password123" });
    expect(reuse.status).toBe(400);
    expect(reuse.code).toBe("INVALID_TOKEN");

    const expired = seedInvite("expired@lexa.dev", { expired: true });
    const expRes = await acceptCode({ token: expired, name: "Exp", password: "password123" });
    expect(expRes.status).toBe(400);
    expect(expRes.code).toBe("INVALID_TOKEN");
  });

  it("rejects an already-accepted invite with INVALID_TOKEN", async () => {
    const token = seedInvite("preaccepted@lexa.dev", { accepted: true });
    const res = await acceptCode({ token, name: "X", password: "password123" });
    expect(res.status).toBe(400);
    expect(res.code).toBe("INVALID_TOKEN");
  });

  it("USER_EXISTS when the email already has an account — invite stays pending (two-step: set-password link)", async () => {
    // an account with the invite's email exists (legacy, password-less)
    await auth.api.createUser({ body: { email: "legacy@lexa.dev", password: "password123", name: "Legacy", data: { role: "member" } } });
    const token = seedInvite("legacy@lexa.dev");
    const res = await acceptCode({ token, name: "X", password: "password123" });
    expect(res.status).toBe(400);
    expect(res.code).toBe("USER_EXISTS");
    const db = new Database(dbPath);
    const row = db.query("SELECT accepted_at FROM workspace_invitations WHERE token = ?").get(token) as { accepted_at: string | null } | null;
    db.close();
    // not stamped — the invite must stay pending so the right path (a
    // superadmin-issued set-password link) is forced
    expect(row?.accepted_at).toBeNull();
  });

  it("rejects a too-short password before creating anything", async () => {
    const token = seedInvite("shortpw@lexa.dev");
    const res = await accept({ token, name: "X", password: "short" });
    expect(res.status).toBe(400);
    const db = new Database(dbPath);
    const user = db.query("SELECT id FROM users WHERE email = 'shortpw@lexa.dev'").get();
    db.close();
    expect(user).toBeNull();
  });
});
