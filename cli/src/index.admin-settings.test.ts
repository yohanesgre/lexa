import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolationDirs, runCli } from "./test-utils";

afterAll(cleanupIsolationDirs);

describe("admin + settings (project/column/swimlane/field-config/settings)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_admin_key_123456789012345678901234567890123456";
  const column = { id: "col-1", projectId: "p1", name: "In Progress", wipLimit: 3, requiredFields: null, color: null, position: 0, githubState: null, isDone: false };
  const fieldConfig = { priorities: [{ id: "pr1", label: "High", color: "#f00", position: 0 }], types: [{ id: "ty1", label: "Bug", color: "#00f", position: 0 }] };
  const rawKey = "lxk_" + "z".repeat(43);

  function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        const method = req.method ?? "GET";
        requests.push({ method, url: url.pathname + url.search, body });
        const p = (): Record<string, unknown> => JSON.parse(body || "{}") as Record<string, unknown>;
        if (url.pathname === "/api/projects/demo/columns" && method === "GET") return json(res, 200, { data: [column] });
        if (url.pathname === "/api/projects/denied" && method === "DELETE") return json(res, 403, { error: { code: "FORBIDDEN", message: "Admin role required" } });
        if (/^\/api\/projects\/demo\/columns\/[^/]+$/.test(url.pathname) && method === "PATCH") { const b = p(); return json(res, 200, { ...column, name: b.name ?? column.name }); }
        if (url.pathname === "/api/projects/demo/field-config" && method === "PUT") return json(res, 200, fieldConfig);
        if (url.pathname === "/api/settings/api-keys" && method === "GET") return json(res, 200, { data: [{ id: "k1", name: "ci", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }] });
        if (url.pathname === "/api/settings/api-keys" && method === "POST") {
          const b = p();
          if (b.name === "no-user") return json(res, 403, { error: { code: "NO_USER_CONTEXT", message: "Bare API key has no user context" } });
          return json(res, 201, { key: { id: "k2", name: "ci", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }, rawKey });
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  function env(): Record<string, string> {
    return { LEXA_URL: base, LEXA_API_KEY: API_KEY };
  }
  function lastReq(method: string, path: string): { method: string; url: string; body: string } | undefined {
    return requests.filter((r) => r.method === method && r.url === path).pop();
  }
  function lastBody(method: string, re: RegExp): Record<string, unknown> | undefined {
    const req = requests.filter((r) => r.method === method && re.test(r.url)).pop();
    return req ? (JSON.parse(req.body) as Record<string, unknown>) : undefined;
  }

  it("project delete without --yes → usage, exit 1, no request sent", async () => {
    const r = await runCli(["project", "delete", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx project delete");
    expect(requests.some((q) => q.method === "DELETE" && q.url === "/api/projects/demo")).toBe(false);
  });

  it("member-bound key 403 → stderr carries Admin role required [FORBIDDEN]", async () => {
    const r = await runCli(["project", "delete", "denied", "--yes"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Admin role required [FORBIDDEN]");
  });

  it("column update maps wip-limit/required-fields/github-state/done flags to the payload", async () => {
    const wip = await runCli(["column", "update", "In Progress", "--project", "demo", "--wip-limit", "none"], env());
    expect(wip.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ wipLimit: null });

    const fields = await runCli(["column", "update", "In Progress", "--project", "demo", "--required-fields="], env());
    expect(fields.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ requiredFields: [] });

    const ghState = await runCli(["column", "update", "In Progress", "--project", "demo", "--github-state", "none"], env());
    expect(ghState.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ githubState: null });

    const doneTrue = await runCli(["column", "update", "In Progress", "--project", "demo", "--done", "true"], env());
    expect(doneTrue.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ isDone: true });

    const doneFalse = await runCli(["column", "update", "In Progress", "--project", "demo", "--done", "false"], env());
    expect(doneFalse.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ isDone: false });
  });

  it("field-config put reads --file - from stdin and reports malformed JSON locally", async () => {
    const payload = { priorities: [{ label: "Mid", color: "#ff0", position: 0 }], types: [] };
    const r = await runCli(["field-config", "put", "--project", "demo", "--file", "-"], env(), JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(JSON.parse(lastReq("PUT", "/api/projects/demo/field-config")!.body)).toEqual(payload);

    const dir = mkdtempSync(join(tmpdir(), "lexa-fc-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    try {
      const bad = await runCli(["field-config", "put", "--project", "demo", "--file", file], env());
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(`Invalid JSON in ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settings api-keys create prints the rawKey exactly once and never on stderr", async () => {
    const r = await runCli(["settings", "api-keys", "create", "--name", "ci"], env());
    expect(r.status).toBe(0);
    expect(r.stdout.split(rawKey).length - 1).toBe(1);
    expect(r.stderr).not.toContain(rawKey);
    expect(JSON.parse(lastReq("POST", "/api/settings/api-keys")!.body)).toEqual({ name: "ci" });
  });

  it("settings api-keys create with a bare/server key 403 NO_USER_CONTEXT → exit 1", async () => {
    const r = await runCli(["settings", "api-keys", "create", "--name", "no-user"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NO_USER_CONTEXT");
  });

  it("settings api-keys list is masked (no rawKey field or value)", async () => {
    const r = await runCli(["settings", "api-keys", "list"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("k1");
    expect(r.stdout).toContain("ci");
    expect(r.stdout).not.toContain(rawKey);
    expect(r.stdout).not.toContain("rawKey");
  });
});
