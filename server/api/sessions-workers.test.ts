import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { createWorkersApiHandler } from "./assistant-api";
import type { StorageConfigShape } from "../storage/config";
import type { ApiAuthHooksShape } from "./auth-hooks";

// Regression: the Workers factory must serve /api/sessions through the
// injected per-request auth hooks, never the Bun-host better-auth singleton
// (whose bun:sqlite constructor throws on workerd → 500).
//
// Two sessions with distinct createdAt pin the descending sort; SESSION_B
// carries a null userAgent to pin the null-normalization.

const SESSION_A = {
  id: "s-a",
  token: "tok-a",
  ipAddress: "10.0.0.1",
  userAgent: null,
  expiresAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
};

const SESSION_B = {
  id: "s-b",
  token: "tok-b",
  ipAddress: null,
  userAgent: "curl/8",
  expiresAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function buildHandler() {
  const db = new Database(":memory:");
  // The middleware re-reads `users.role` per session request; seed the minimal
  // row so the injected session identity resolves (a missing row → 401).
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member')");
  db.prepare("INSERT INTO users (id, role) VALUES ('u1', 'member')").run();
  const fsRoot = mkdtempSync(join(tmpdir(), "lexa-sessions-workers-"));
  const storage: StorageConfigShape = {
    driver: "fs",
    fsRoot,
    s3: null,
    r2: null,
    maxUploadBytes: 25 * 1024 * 1024,
  };
  const listSessions = vi.fn(async (_headers: Headers) => [SESSION_A, SESSION_B]);
  const revokeSession = vi.fn(async (_input: { token: string; headers: Headers }) => ({ ok: true }));
  const authHooks: ApiAuthHooksShape = {
    createUser: async () => {
      throw new Error("unused");
    },
    listSessions,
    revokeSession,
  };
  const handler = createWorkersApiHandler({
    driver: createBunSqliteDriver(db),
    runtimeEnv: { LXK_ENV: "dev" },
    storage,
    authHooks,
    getSession: async () => ({ user: { id: "u1", name: "Test", role: "member" } }),
  });
  return { handler, listSessions, revokeSession, fsRoot, db };
}

const call = (handler: (req: Request) => Promise<Response>, method: string, path: string) =>
  handler(
    new Request(`http://lexa.test${path}`, {
      method,
      headers: { cookie: "better-auth.session_token=fake" },
    })
  );

describe("workers sessions via auth hooks", () => {
  it("GET /api/sessions lists through the injected hooks, sorted desc by createdAt", async () => {
    const { handler, listSessions, fsRoot, db } = buildHandler();
    try {
      const res = await call(handler, "GET", "/api/sessions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown };
      expect(body).toEqual({
        data: [
          { id: "s-a", ipAddress: "10.0.0.1", userAgent: null, expiresAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "s-b", ipAddress: null, userAgent: "curl/8", expiresAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      expect(listSessions).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(fsRoot, { recursive: true, force: true });
      db.close();
    }
  });

  it("POST /api/sessions/:id/revoke resolves the id → token through the hooks", async () => {
    const { handler, revokeSession, fsRoot, db } = buildHandler();
    try {
      const res = await call(handler, "POST", `/api/sessions/${SESSION_B.id}/revoke`);
      expect(res.status).toBe(204);
      expect(revokeSession).toHaveBeenCalledTimes(1);
      expect(revokeSession.mock.calls[0]![0]).toMatchObject({ token: SESSION_B.token });
    } finally {
      rmSync(fsRoot, { recursive: true, force: true });
      db.close();
    }
  });

  it("POST /api/sessions/unknown/revoke → 404 SESSION_NOT_FOUND", async () => {
    const { handler, revokeSession, fsRoot, db } = buildHandler();
    try {
      const res = await call(handler, "POST", "/api/sessions/nope/revoke");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SESSION_NOT_FOUND");
      expect(revokeSession).not.toHaveBeenCalled();
    } finally {
      rmSync(fsRoot, { recursive: true, force: true });
      db.close();
    }
  });
});
