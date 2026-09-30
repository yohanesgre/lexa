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
        if (url.pathname === "/api/projects/demo/swimlanes") {
          res.end(JSON.stringify({ data: [{ id: "lane-2", name: "Lane Two", position: 1 }] }));
          return;
        }
        const move = url.pathname.match(/^\/api\/projects\/demo\/tasks\/(.+)\/move$/);
        if (req.method === "POST" && move) {
          const payload = JSON.parse(body) as { columnId: string; swimlaneId: string };
          res.end(JSON.stringify({ data: { ...task, columnId: payload.columnId, swimlaneId: payload.swimlaneId } }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/projects/demo/tasks") {
          res.end(JSON.stringify({ data: [task] }));
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

  function moveRequest(): { columnId: string; swimlaneId: string } | undefined {
    const req = requests.find((q) => q.method === "POST" && q.url.endsWith("/move"));
    return req ? (JSON.parse(req.body) as { columnId: string; swimlaneId: string }) : undefined;
  }

  it("task move without --swimlane sends the task's current non-empty swimlaneId", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    const payload = moveRequest();
    expect(payload).toBeDefined();
    expect(payload!.columnId).toBe("col-1");
    expect(payload!.swimlaneId).toBe("lane-1");
    expect(payload!.swimlaneId).not.toBe("");
  });

  it("task move with --swimlane sends the resolved named swimlane id", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "Lane Two"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(moveRequest()!.swimlaneId).toBe("lane-2");
  });

  it("task list non-JSON output shows the full UUID", async () => {
    const r = await runCli(["task", "list", "--project", "demo"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(UUID);
  });

  it("PREFIX-N task id passes through to the server verbatim (no client-side list scan)", async () => {
    const r = await runCli(["task", "move", "NIM-12", "--project", "demo", "--column", "In Progress"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/tasks/NIM-12")).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
    expect(moveRequest()!.swimlaneId).toBe("lane-1");
  });

  it("full UUID task id passes through unchanged", async () => {
    const r = await runCli(["task", "get", UUID, "--project", "demo", "--json"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === `/api/projects/demo/tasks/${UUID}`)).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
  });

  it("PREFIX-N task id passes through for task get too", async () => {
    const r = await runCli(["task", "get", "NIM-12", "--project", "demo", "--json"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
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
        if (method === "POST" && url.pathname === "/api/projects/demo/wiki") {
          const payload = JSON.parse(body || "{}") as { title?: string; slug?: string; parentId?: string };
          res.writeHead(201);
          res.end(JSON.stringify({ ...page, title: payload.title ?? "", slug: payload.slug ?? "new-page", parentId: payload.parentId ?? null }));
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
        const linkExisting = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link-existing$/);
        if (method === "POST" && linkExisting) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const unlink = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link\/([^/]+)$/);
        if (method === "DELETE" && unlink) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const link = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link$/);
        if (method === "POST" && link) {
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

  it("task delete → 204, exit 0, prints Deleted", async () => {
    const r = await runCli(["task", "delete", UUID, "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Deleted ");
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}`)).toBeDefined();
  });

  it("task delete 409 TASK_HAS_CHILDREN → exit 1 with the [CODE] suffix", async () => {
    const r = await runCli(["task", "delete", "has-children", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TASK_HAS_CHILDREN");
    expect(r.stderr).toContain("[TASK_HAS_CHILDREN]");
  });

  it("task update --description sends a TipTap doc", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo", "--description", "hello"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { description?: { type?: string } };
    expect(body.description?.type).toBe("doc");
  });

  it("task update --assignees a,b → array; --assignees= → empty array", async () => {
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees", "a,b"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual(["a", "b"]);
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees="], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual([]);
  });

  it("task update bare --assignees (no value) → usage, exit 1", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo", "--assignees"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task update");
  });

  it("task update --due sets dueAt; --clear-due sends dueAt: null", async () => {
    await runCli(["task", "update", UUID, "--project", "demo", "--due", "2026-10-01"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBe("2026-10-01");
    await runCli(["task", "update", UUID, "--project", "demo", "--clear-due"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBeNull();
  });

  it("task update with no field flags → usage, exit 1", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task update");
  });

  it("wiki create prints the created slug", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("new-page");
    const body = JSON.parse(lastReq("POST", "/api/projects/demo/wiki")!.body) as { title?: string };
    expect(body.title).toBe("New Page");
  });

  it("wiki update --slug prints the rename arrow", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--slug", "new-slug"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("→ new-slug");
  });

  it("wiki update --parent-root sends parentId: null", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent-root"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBeNull();
  });

  it("wiki update --parent resolves the parent slug to its page id", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent", "root-page"], env());
    expect(r.status).toBe(0);
    expect(lastReq("GET", "/api/projects/demo/wiki/root-page")).toBeDefined();
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBe("w-page");
  });

  it("wiki create --content sends a TipTap doc", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page", "--content", "hello"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("POST", "/api/projects/demo/wiki")!.body) as { content?: { type?: string } }).content?.type).toBe("doc");
  });

  it("wiki update --content sends a TipTap doc", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--content", "hello"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { content?: { type?: string } }).content?.type).toBe("doc");
  });

  it("wiki update --parent= (empty) → usage, exit 1", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx wiki update");
  });

  it("wiki create --content= (empty) → usage, exit 1", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page", "--content="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx wiki create");
  });

  it("wiki delete 409 HAS_CHILDREN → exit 1 with the [CODE] suffix", async () => {
    const r = await runCli(["wiki", "delete", "parent-page", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HAS_CHILDREN");
    expect(r.stderr).toContain("[HAS_CHILDREN]");
  });

  it("github link POSTs repo and prints Linked", async () => {
    const r = await runCli(["github", "link", UUID, "--project", "demo", "--repo", "owner/repo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`  Linked ${UUID} → owner/repo`);
    const body = JSON.parse(lastReq("POST", `/api/projects/demo/tasks/${UUID}/github-link`)!.body) as { repo?: string };
    expect(body).toEqual({ repo: "owner/repo" });
  });

  it("github link-existing POSTs repo + issueNumber", async () => {
    const r = await runCli(["github", "link-existing", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "7"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("POST", `/api/projects/demo/tasks/${UUID}/github-link-existing`)!.body) as { repo?: string; issueNumber?: number };
    expect(body).toEqual({ repo: "owner/repo", issueNumber: 7 });
  });

  it("github unlink --issue-id unlinks by node id", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--issue-id", "i9"], env());
    expect(r.status).toBe(0);
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i9`)).toBeDefined();
  });

  it("github unlink --repo + --issue resolves the node id via task get", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "5"], env());
    expect(r.status).toBe(0);
    expect(lastReq("GET", `/api/projects/demo/tasks/${UUID}`)).toBeDefined();
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i1`)).toBeDefined();
  });

  it("github unlink with an unmatched repo+issue → exit 1", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "99"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No linked issue");
  });

  it("group help lists the new subcommands", async () => {
    const taskHelp = await runCli(["task", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(taskHelp.status).toBe(1);
    expect(taskHelp.stdout).toContain("task delete");
    const wikiHelp = await runCli(["wiki", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(wikiHelp.status).toBe(1);
    expect(wikiHelp.stdout).toContain("wiki create");
    const githubHelp = await runCli(["github", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(githubHelp.status).toBe(1);
    expect(githubHelp.stdout).toContain("github link <id> --project <slug> --repo <owner/name>");
  });
});
