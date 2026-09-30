import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanupIsolationDirs, runCli } from "./test-utils";

afterAll(cleanupIsolationDirs);

describe("planning surface (column/swimlane/milestone + task move edges)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_planning_key_123456789012345678901234567890123";
  const UUID = "11111111-2222-3333-4444-555555555555";
  const task = {
    id: UUID,
    key: "NIM-12",
    title: "Fix the thing",
    priority: null,
    type: null,
    columnId: "col-1",
    swimlaneId: "lane-1",
    assignees: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const columns = [
    { id: "col-1", projectId: "p1", name: "In Progress", wipLimit: 3, requiredFields: null, color: null, position: 0, githubState: null, isDone: false },
    { id: "col-2", projectId: "p1", name: "Done", wipLimit: null, requiredFields: null, color: null, position: 1, githubState: "closed", isDone: true },
    { id: "col-wip", projectId: "p1", name: "Full", wipLimit: 1, requiredFields: null, color: null, position: 2, githubState: null, isDone: false },
  ];
  const swimlanes = [
    { id: "lane-1", projectId: "p1", name: "Sprint A", description: "", position: 0, dueAt: "2026-06-01", archivedAt: null, startAt: "2026-05-01", kind: "sprint", milestoneId: "ms-1" },
  ];
  const milestones = [
    { id: "ms-1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: "2026-09-30", archivedAt: null, sprintCount: 2, archivedSprintCount: 0 },
  ];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        const method = req.method ?? "GET";
        requests.push({ method, url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/projects/demo/columns" && method === "GET") { res.end(JSON.stringify({ data: columns })); return; }
        if (url.pathname === "/api/projects/demo/swimlanes" && method === "GET") { res.end(JSON.stringify({ data: swimlanes })); return; }
        if (url.pathname === "/api/projects/demo/milestones" && method === "GET") { res.end(JSON.stringify({ data: milestones })); return; }
        if (url.pathname === "/api/projects/demo/milestones" && method === "POST") {
          const p = JSON.parse(body || "{}") as { name?: string; description?: string; dueAt?: string | null };
          res.writeHead(201);
          res.end(JSON.stringify({ ...milestones[0], name: p.name ?? milestones[0]!.name, description: p.description ?? "", dueAt: p.dueAt ?? null }));
          return;
        }
        const ms = url.pathname.match(/^\/api\/projects\/demo\/milestones\/([^/]+)$/);
        if (ms && method === "PATCH") {
          const p = JSON.parse(body || "{}") as { name?: string; dueAt?: string | null };
          res.end(JSON.stringify({ ...milestones[0], name: p.name ?? milestones[0]!.name, dueAt: p.dueAt !== undefined ? p.dueAt : milestones[0]!.dueAt }));
          return;
        }
        const getTask = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)$/);
        if (getTask && method === "GET") { res.end(JSON.stringify(task)); return; }
        const move = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/move$/);
        if (move && method === "POST") {
          const p = JSON.parse(body || "{}") as { columnId: string; swimlaneId: string };
          if (p.columnId === "col-wip") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "WIP_LIMIT", message: "WIP limit reached", details: { limit: 1 } } }));
            return;
          }
          res.end(JSON.stringify({ data: { ...task, columnId: p.columnId, swimlaneId: p.swimlaneId }, activity: [] }));
          return;
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
  function lastMove(): { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean } | undefined {
    const req = requests.filter((r) => r.method === "POST" && r.url.endsWith("/move")).pop();
    return req ? (JSON.parse(req.body) as { columnId: string; swimlaneId: string }) : undefined;
  }

  it("column list shows WIP/DONE/GITHUB with — for a missing WIP limit", async () => {
    const r = await runCli(["column", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("WIP");
    expect(lines[0]).toContain("DONE");
    expect(lines[0]).toContain("GITHUB");
    const progress = lines.find((l) => l.startsWith("col-1"))!;
    expect(progress).toContain("3");
    const done = lines.find((l) => l.startsWith("col-2"))!;
    expect(done).toContain("—");
    expect(done).toContain("yes");
    expect(done).toContain("closed");
  });

  it("column list --json emits the raw payload", async () => {
    const r = await runCli(["column", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((c) => c.id)).toEqual(["col-1", "col-2", "col-wip"]);
  });

  it("swimlane list --json emits the raw payload", async () => {
    const r = await runCli(["swimlane", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((l) => l.id)).toEqual(["lane-1"]);
  });

  it("milestone list --json emits the raw payload", async () => {
    const r = await runCli(["milestone", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((m) => m.id)).toEqual(["ms-1"]);
  });

  it("swimlane list includes KIND/DUE columns", async () => {
    const r = await runCli(["swimlane", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    const header = r.stdout.split("\n")[0]!;
    expect(header).toContain("KIND");
    expect(header).toContain("DUE");
    expect(r.stdout).toContain("sprint");
    expect(r.stdout).toContain("2026-06-01");
  });

  it("milestone list includes DUE and the sprint count when the payload carries it", async () => {
    const r = await runCli(["milestone", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2026-09-30");
    expect(r.stdout).toContain("SPRINTS");
    expect(r.stdout).toContain("2");
  });

  it("milestone create posts { name, dueAt } and prints the created milestone", async () => {
    const r = await runCli(["milestone", "create", "--project", "demo", "--name", "v2", "--due", "2027-01-31"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Created milestone ms-1 — v2");
    const body = JSON.parse(lastReq("POST", "/api/projects/demo/milestones")!.body) as Record<string, unknown>;
    expect(body).toEqual({ name: "v2", dueAt: "2027-01-31" });
  });

  it("milestone create without --name → usage, exit 1", async () => {
    const r = await runCli(["milestone", "create", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone create");
  });

  it("milestone update resolves by exact name, posts the new name, prints the result", async () => {
    const r = await runCli(["milestone", "update", "v1", "--project", "demo", "--name", "v1.1"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Updated milestone ms-1 — v1.1");
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as Record<string, unknown>;
    expect(body).toEqual({ name: "v1.1" });
  });

  it("milestone update --clear-due sends dueAt: null", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--clear-due"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as { dueAt?: string | null };
    expect(body.dueAt).toBeNull();
  });

  it("milestone update with no mutation flag → usage, exit 1", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone update");
  });

  it("milestone update resolves a mixed-case ref case-insensitively", async () => {
    const r = await runCli(["milestone", "update", "V1", "--project", "demo", "--name", "v1.2"], env());
    expect(r.status).toBe(0);
    expect(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")).toBeDefined();
  });

  it("milestone update --position <n> sends position in the body", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--position", "2"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as { position?: number };
    expect(body).toEqual({ position: 2 });
  });

  it("milestone update --name= (empty) → usage, exit 1", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--name="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone update");
  });

  it("unknown milestone ref → exit 1 listing the available names", async () => {
    const r = await runCli(["milestone", "update", "Nope", "--project", "demo", "--name", "x"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Milestone "Nope" not found. Available: v1');
  });

  it("unknown column ref → exit 1 listing the available names", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "Nope"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Column "Nope" not found. Available: In Progress, Done, Full');
  });

  it("unknown swimlane ref → exit 1 listing the available names", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "Nope"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Swimlane "Nope" not found. Available: Sprint A');
  });

  it("task move --before passes beforeTaskId verbatim (PREFIX-N)", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before", "NIM-3"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
    expect(lastMove()!.beforeTaskId).toBe("NIM-3");
  });

  it("task move --after passes afterTaskId verbatim", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--after", "NIM-4"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.afterTaskId).toBe("NIM-4");
  });

  it("task move --clear-due sends clearDueAt: true", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--clear-due"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.clearDueAt).toBe(true);
  });

  it("task move --before + --after → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before", "NIM-3", "--after", "NIM-4"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("task move WIP 409 → stderr carries the [WIP_LIMIT] suffix", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "Full"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("WIP_LIMIT");
    expect(r.stderr).toContain("[WIP_LIMIT]");
  });

  it("task move resolves a column by exact id first", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "col-1"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
  });

  it("task move --swimlane resolves by id before name", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "lane-1"], env());
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/swimlanes")).toBe(true);
    expect(lastMove()!.swimlaneId).toBe("lane-1");
  });

  it("task move bare --before (no value) → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("task move --after= (empty) → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--after="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("group help lists the planning subcommands", async () => {
    const col = await runCli(["column", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(col.status).toBe(1);
    expect(col.stdout).toContain("column list");
    const lane = await runCli(["swimlane", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(lane.status).toBe(1);
    expect(lane.stdout).toContain("swimlane list");
    const ms = await runCli(["milestone", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(ms.status).toBe(1);
    expect(ms.stdout).toContain("milestone create");
  });
});
