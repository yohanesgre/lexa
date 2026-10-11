import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanupIsolationDirs, runCli } from "./test-utils";

afterAll(cleanupIsolationDirs);

describe("task id resolution + move (server-delegating)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_move_key_1234567890123456789012345678901234567890";
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

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/projects/demo/columns") {
          res.end(JSON.stringify({ data: [{ id: "col-1", name: "In Progress", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: null }] }));
          return;
        }
        const move = url.pathname.match(/^\/api\/projects\/demo\/tasks\/(.+)\/move$/);
        if (req.method === "POST" && move) {
          const payload = JSON.parse(body) as { columnId: string; swimlaneId: string };
          res.end(JSON.stringify({ data: { ...task, columnId: payload.columnId, swimlaneId: payload.swimlaneId } }));
          return;
        }
        const get = url.pathname.match(/^\/api\/projects\/demo\/tasks\/(.+)$/);
        if (req.method === "GET" && get) {
          res.end(JSON.stringify(task));
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
  function moveRequest(): { columnId: string; swimlaneId: string } | undefined {
    const req = requests.find((q) => q.method === "POST" && q.url.endsWith("/move"));
    return req ? (JSON.parse(req.body) as { columnId: string; swimlaneId: string }) : undefined;
  }

  it("PREFIX-N and full-UUID task ids pass through to the server verbatim (no client-side list scan)", async () => {
    const moved = await runCli(["task", "move", "NIM-12", "--project", "demo", "--column", "In Progress"], env());
    expect(moved.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/tasks/NIM-12")).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
    expect(moveRequest()!.swimlaneId).toBe("lane-1");

    const uuid = await runCli(["task", "get", UUID, "--project", "demo", "--json"], env());
    expect(uuid.status).toBe(0);
    expect(requests.some((q) => q.url === `/api/projects/demo/tasks/${UUID}`)).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);

    const key = await runCli(["task", "get", "NIM-12", "--project", "demo", "--json"], env());
    expect(key.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/tasks/NIM-12")).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
  });
});

describe("lifecycle writes (task delete/update, wiki, github links)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_lifecycle_key_12345678901234567890123456789012345678";
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
    githubs: [{ issueId: "i1", issueNumber: 5, repo: "owner/repo", syncedState: "open", url: "https://github.com/owner/repo/issues/5", outOfSync: false }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const page = {
    id: "w-page",
    projectId: "p1",
    title: "Old Title",
    slug: "old-slug",
    content: { type: "doc", content: [] },
    parentId: null,
    position: 0,
    updatedBy: null,
    updatedByName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        const method = req.method ?? "GET";
        requests.push({ method, url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        const wikiPage = url.pathname.match(/^\/api\/projects\/demo\/wiki\/([^/]+)$/);
        if (method === "GET" && wikiPage?.[1] !== undefined) {
          res.end(JSON.stringify({ ...page, slug: wikiPage[1] }));
          return;
        }
        if (method === "PATCH" && wikiPage?.[1] !== undefined) {
          const payload = JSON.parse(body || "{}") as { slug?: string; title?: string; parentId?: string | null };
          res.end(JSON.stringify({ ...page, slug: payload.slug ?? wikiPage[1], title: payload.title ?? page.title, parentId: payload.parentId !== undefined ? payload.parentId : page.parentId }));
          return;
        }
        if (method === "DELETE" && wikiPage?.[1] !== undefined) {
          if (wikiPage[1] === "parent-page") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "HAS_CHILDREN", message: "page has children", details: { count: 1 } } }));
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        const unlink = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link\/([^/]+)$/);
        if (method === "DELETE" && unlink) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const taskMatch = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)$/);
        if (method === "PATCH" && taskMatch) {
          const payload = JSON.parse(body || "{}") as { title?: string };
          res.end(JSON.stringify({ data: { ...task, title: payload.title ?? task.title }, activity: [] }));
          return;
        }
        if (method === "DELETE" && taskMatch) {
          if (taskMatch[1] === "has-children") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "TASK_HAS_CHILDREN", message: "task has children" } }));
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === "GET" && taskMatch) {
          res.end(JSON.stringify(task));
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

  it("parent guards: task delete 409 TASK_HAS_CHILDREN and wiki delete 409 HAS_CHILDREN exit 1 with [CODE]", async () => {
    const taskDel = await runCli(["task", "delete", "has-children", "--project", "demo"], env());
    expect(taskDel.status).toBe(1);
    expect(taskDel.stderr).toContain("TASK_HAS_CHILDREN");
    expect(taskDel.stderr).toContain("[TASK_HAS_CHILDREN]");

    const wikiDel = await runCli(["wiki", "delete", "parent-page", "--project", "demo"], env());
    expect(wikiDel.status).toBe(1);
    expect(wikiDel.stderr).toContain("HAS_CHILDREN");
    expect(wikiDel.stderr).toContain("[HAS_CHILDREN]");
  });

  it("task update maps assignees/due flags to the payload and rejects a no-flag update", async () => {
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees", "a,b"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual(["a", "b"]);
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees="], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual([]);
    await runCli(["task", "update", UUID, "--project", "demo", "--due", "2026-10-01"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBe("2026-10-01");
    await runCli(["task", "update", UUID, "--project", "demo", "--clear-due"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBeNull();

    const noFlags = await runCli(["task", "update", UUID, "--project", "demo"], env());
    expect(noFlags.status).toBe(1);
    expect(noFlags.stderr).toContain("Usage: lx task update");
  });

  it("wiki update --parent-root sends parentId: null and --parent resolves the slug to its page id", async () => {
    const root = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent-root"], env());
    expect(root.status).toBe(0);
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBeNull();

    const child = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent", "root-page"], env());
    expect(child.status).toBe(0);
    expect(lastReq("GET", "/api/projects/demo/wiki/root-page")).toBeDefined();
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBe("w-page");
  });

  it("github unlink by --issue-id, by --repo+--issue (node-id resolution), and the unmatched case", async () => {
    const byId = await runCli(["github", "unlink", UUID, "--project", "demo", "--issue-id", "i9"], env());
    expect(byId.status).toBe(0);
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i9`)).toBeDefined();

    const byIssue = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "5"], env());
    expect(byIssue.status).toBe(0);
    expect(lastReq("GET", `/api/projects/demo/tasks/${UUID}`)).toBeDefined();
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i1`)).toBeDefined();

    const unmatched = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "99"], env());
    expect(unmatched.status).toBe(1);
    expect(unmatched.stderr).toContain("No linked issue");
  });
});

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

  it("unknown milestone/column/swimlane refs exit 1 listing the available names", async () => {
    const ms = await runCli(["milestone", "update", "Nope", "--project", "demo", "--name", "x"], env());
    expect(ms.status).toBe(1);
    expect(ms.stderr).toContain('Milestone "Nope" not found. Available: v1');

    const col = await runCli(["task", "move", UUID, "--project", "demo", "--column", "Nope"], env());
    expect(col.status).toBe(1);
    expect(col.stderr).toContain('Column "Nope" not found. Available: In Progress, Done, Full');

    const lane = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "Nope"], env());
    expect(lane.status).toBe(1);
    expect(lane.stderr).toContain('Swimlane "Nope" not found. Available: Sprint A');
  });

  it("resolves a mixed-case milestone ref and a --swimlane id before name", async () => {
    const ms = await runCli(["milestone", "update", "V1", "--project", "demo", "--name", "v1.2"], env());
    expect(ms.status).toBe(0);
    expect(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")).toBeDefined();

    const moved = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "lane-1"], env());
    expect(moved.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/swimlanes")).toBe(true);
    expect(lastMove()!.swimlaneId).toBe("lane-1");
  });

  it("task move with no --swimlane sends the task's current swimlane (column resolved by exact id first)", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "col-1"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
    expect(lastMove()!.swimlaneId).toBe("lane-1");
  });

  it("task move --before/--after pass ids verbatim and --clear-due sends clearDueAt: true", async () => {
    const before = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before", "NIM-3"], env());
    expect(before.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
    expect(lastMove()!.beforeTaskId).toBe("NIM-3");

    const after = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--after", "NIM-4"], env());
    expect(after.status).toBe(0);
    expect(lastMove()!.afterTaskId).toBe("NIM-4");

    const clearDue = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--clear-due"], env());
    expect(clearDue.status).toBe(0);
    expect(lastMove()!.clearDueAt).toBe(true);
  });

  it("task move --before + --after is a usage error with no request sent", async () => {
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
});
