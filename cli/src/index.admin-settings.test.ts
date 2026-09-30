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
  const swimlane = { id: "lane-1", projectId: "p1", name: "Sprint A", description: "", position: 0, dueAt: "2026-06-01", archivedAt: null, startAt: "2026-05-01", kind: "sprint", milestoneId: "ms-1" };
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
        if (url.pathname === "/api/projects/demo/swimlanes" && method === "GET") return json(res, 200, { data: [swimlane] });
        if (url.pathname === "/api/projects/demo/milestones" && method === "GET") return json(res, 200, { data: [] });
        if (url.pathname === "/api/projects" && method === "POST") { const b = p(); return json(res, 201, { id: "p2", slug: b.slug ?? "new", name: b.name, description: b.description ?? null }); }
        if (url.pathname === "/api/projects/demo" && method === "PATCH") { const b = p(); return json(res, 200, { id: "p1", slug: "demo", name: b.name ?? "Demo", description: b.description ?? null }); }
        if (url.pathname === "/api/projects/demo" && method === "DELETE") { res.writeHead(204); return res.end(); }
        if (url.pathname === "/api/projects/denied" && method === "DELETE") return json(res, 403, { error: { code: "FORBIDDEN", message: "Admin role required" } });
        if (url.pathname === "/api/projects/demo/columns" && method === "POST") { const b = p(); return json(res, 201, { ...column, id: "col-new", name: b.name }); }
        if (/^\/api\/projects\/demo\/columns\/[^/]+$/.test(url.pathname) && method === "PATCH") { const b = p(); return json(res, 200, { ...column, name: b.name ?? column.name }); }
        if (/^\/api\/projects\/demo\/columns\/[^/]+$/.test(url.pathname) && method === "DELETE") { res.writeHead(204); return res.end(); }
        if (url.pathname === "/api/projects/demo/swimlanes" && method === "POST") { const b = p(); return json(res, 201, { ...swimlane, id: "lane-new", name: b.name }); }
        if (/^\/api\/projects\/demo\/swimlanes\/[^/]+$/.test(url.pathname) && method === "PATCH") { const b = p(); return json(res, 200, { ...swimlane, name: b.name ?? swimlane.name, dueAt: b.dueAt !== undefined ? b.dueAt : swimlane.dueAt, milestoneId: b.milestoneId !== undefined ? b.milestoneId : swimlane.milestoneId }); }
        if (/^\/api\/projects\/demo\/swimlanes\/[^/]+$/.test(url.pathname) && method === "DELETE") { res.writeHead(204); return res.end(); }
        if (url.pathname === "/api/projects/demo/field-config" && method === "GET") return json(res, 200, fieldConfig);
        if (url.pathname === "/api/projects/demo/field-config" && method === "PUT") return json(res, 200, fieldConfig);
        if (url.pathname === "/api/settings/rate-limit" && method === "GET") return json(res, 200, { max: 6000, windowMs: 600000, envOverride: false });
        if (url.pathname === "/api/settings/rate-limit" && method === "PUT") return json(res, 200, { max: 100, windowMs: 120000, envOverride: false });
        if (url.pathname === "/api/settings/api-keys" && method === "GET") return json(res, 200, { data: [{ id: "k1", name: "ci", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }] });
        if (url.pathname === "/api/settings/api-keys" && method === "POST") {
          const b = p();
          if (b.name === "no-user") return json(res, 403, { error: { code: "NO_USER_CONTEXT", message: "Bare API key has no user context" } });
          return json(res, 201, { key: { id: "k2", name: "ci", createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null }, rawKey });
        }
        if (/^\/api\/settings\/api-keys\/[^/]+$/.test(url.pathname) && method === "DELETE") { res.writeHead(204); return res.end(); }
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

  it("project create posts the payload and prints the created slug", async () => {
    const r = await runCli(["project", "create", "--name", "New", "--slug", "new", "--description", "d"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Created project new — New");
    expect(JSON.parse(lastReq("POST", "/api/projects")!.body)).toEqual({ name: "New", slug: "new", description: "d" });
  });

  it("project create without --name → usage, exit 1", async () => {
    const r = await runCli(["project", "create"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx project create");
  });

  it("project create bare --description (no value) → usage, exit 1", async () => {
    const r = await runCli(["project", "create", "--name", "P", "--description"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx project create");
  });

  it("project update posts only the provided fields", async () => {
    const r = await runCli(["project", "update", "demo", "--name", "Demo 2"], env());
    expect(r.status).toBe(0);
    expect(JSON.parse(lastReq("PATCH", "/api/projects/demo")!.body)).toEqual({ name: "Demo 2" });
  });

  it("project update with no flags → usage, exit 1", async () => {
    const r = await runCli(["project", "update", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx project update");
  });

  it("project delete without --yes → usage, exit 1, no request sent", async () => {
    const r = await runCli(["project", "delete", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx project delete");
    expect(requests.some((q) => q.method === "DELETE" && q.url === "/api/projects/demo")).toBe(false);
  });

  it("project delete --yes DELETEs and prints Deleted", async () => {
    const r = await runCli(["project", "delete", "demo", "--yes"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Deleted project demo");
    expect(requests.some((q) => q.method === "DELETE" && q.url === "/api/projects/demo")).toBe(true);
  });

  it("member-bound key 403 → stderr carries Admin role required [FORBIDDEN]", async () => {
    const r = await runCli(["project", "delete", "denied", "--yes"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Admin role required [FORBIDDEN]");
  });

  it("column create posts the payload and prints the created column", async () => {
    const r = await runCli(["column", "create", "--project", "demo", "--name", "Todo", "--wip-limit", "2", "--github-state", "open"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Created column col-new — Todo");
    expect(JSON.parse(lastReq("POST", "/api/projects/demo/columns")!.body)).toEqual({ name: "Todo", wipLimit: 2, githubState: "open" });
  });

  it("column create --name= (empty) → usage, exit 1", async () => {
    const r = await runCli(["column", "create", "--project", "demo", "--name="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx column create");
  });

  it("column update --wip-limit none → wipLimit: null", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--wip-limit", "none"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ wipLimit: null });
  });

  it("column update --required-fields= → []", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--required-fields="], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ requiredFields: [] });
  });

  it("column update --done true → isDone: true", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--done", "true"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ isDone: true });
  });

  it("column update --github-state none → githubState: null", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--github-state", "none"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ githubState: null });
  });

  it("column update --done false → isDone: false", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--done", "false"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ isDone: false });
  });

  it("column update --position 2 → position: 2", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--position", "2"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/columns\//)).toEqual({ position: 2 });
  });

  it("column update --color none → usage, exit 1 (none is a NullOr-only sentinel)", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo", "--color", "none"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx column update");
  });

  it("column update with no flags → usage, exit 1", async () => {
    const r = await runCli(["column", "update", "In Progress", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx column update");
  });

  it("column delete resolves the ref and DELETEs it", async () => {
    const r = await runCli(["column", "delete", "In Progress", "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Deleted column col-1 — In Progress");
    expect(requests.some((q) => q.method === "DELETE" && q.url === "/api/projects/demo/columns/col-1")).toBe(true);
  });

  it("swimlane create posts the payload and prints the created lane", async () => {
    const r = await runCli(["swimlane", "create", "--project", "demo", "--name", "Sprint B"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Created swimlane lane-new — Sprint B");
    expect(JSON.parse(lastReq("POST", "/api/projects/demo/swimlanes")!.body)).toEqual({ name: "Sprint B" });
  });

  it("swimlane update --milestone none → milestoneId: null", async () => {
    const r = await runCli(["swimlane", "update", "lane-1", "--project", "demo", "--milestone", "none"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/swimlanes\//)).toEqual({ milestoneId: null });
  });

  it("swimlane update --due none → dueAt: null", async () => {
    const r = await runCli(["swimlane", "update", "lane-1", "--project", "demo", "--due", "none"], env());
    expect(r.status).toBe(0);
    expect(lastBody("PATCH", /\/swimlanes\//)).toEqual({ dueAt: null });
  });

  it("swimlane update with no flags → usage, exit 1", async () => {
    const r = await runCli(["swimlane", "update", "lane-1", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx swimlane update");
  });

  it("swimlane delete resolves the ref and DELETEs it", async () => {
    const r = await runCli(["swimlane", "delete", "Sprint A", "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Deleted swimlane lane-1 — Sprint A");
  });

  it("field-config get prints two tables", async () => {
    const r = await runCli(["field-config", "get", "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Priorities:");
    expect(r.stdout).toContain("Types:");
    expect(r.stdout).toContain("High");
    expect(r.stdout).toContain("Bug");
  });

  it("field-config get --json emits the raw config", async () => {
    const r = await runCli(["field-config", "get", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(fieldConfig);
  });

  it("field-config put --file sends the file body wholesale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-fc-"));
    const file = join(dir, "fc.json");
    const payload = { priorities: [{ label: "Low", color: "#0f0", position: 0 }], types: [] };
    writeFileSync(file, JSON.stringify(payload));
    try {
      const r = await runCli(["field-config", "put", "--project", "demo", "--file", file], env());
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("  Updated field-config (priorities: 1, types: 1)");
      expect(JSON.parse(lastReq("PUT", "/api/projects/demo/field-config")!.body)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("field-config put --file malformed JSON → local error, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-fc-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    try {
      const r = await runCli(["field-config", "put", "--project", "demo", "--file", file], env());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Invalid JSON in ${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("field-config put --file - reads the payload from stdin", async () => {
    const payload = { priorities: [{ label: "Mid", color: "#ff0", position: 0 }], types: [] };
    const r = await runCli(["field-config", "put", "--project", "demo", "--file", "-"], env(), JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(JSON.parse(lastReq("PUT", "/api/projects/demo/field-config")!.body)).toEqual(payload);
  });

  it("settings rate-limit set converts --window-min to windowMs", async () => {
    const r = await runCli(["settings", "rate-limit", "set", "--max", "100", "--window-min", "2"], env());
    expect(r.status).toBe(0);
    expect(JSON.parse(lastReq("PUT", "/api/settings/rate-limit")!.body)).toEqual({ max: 100, windowMs: 120000 });
  });

  it("settings rate-limit set missing --window-min → usage, exit 1", async () => {
    const r = await runCli(["settings", "rate-limit", "set", "--max", "100"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx settings rate-limit set");
  });

  it("settings rate-limit get prints the effective values", async () => {
    const r = await runCli(["settings", "rate-limit", "get"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("6000");
    expect(r.stdout).toContain("600000");
  });

  it("settings api-keys create prints the rawKey once", async () => {
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

  it("settings api-keys list is masked (no rawKey)", async () => {
    const r = await runCli(["settings", "api-keys", "list"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("k1");
    expect(r.stdout).toContain("ci");
    expect(r.stdout).not.toContain(rawKey);
    expect(r.stdout).not.toContain("rawKey");
  });

  it("settings api-keys revoke DELETEs the key path", async () => {
    const r = await runCli(["settings", "api-keys", "revoke", "k1"], env());
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.method === "DELETE" && q.url === "/api/settings/api-keys/k1")).toBe(true);
  });

  it("group help lists the new commands", async () => {
    const project = await runCli(["project", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(project.status).toBe(1);
    expect(project.stdout).toContain("project create");
    const col = await runCli(["column", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(col.stdout).toContain("column create");
    const lane = await runCli(["swimlane", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(lane.stdout).toContain("swimlane create");
    const fc = await runCli(["field-config", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(fc.stdout).toContain("field-config get");
    const settings = await runCli(["settings", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(settings.stdout).toContain("settings rate-limit get");
  });
});
