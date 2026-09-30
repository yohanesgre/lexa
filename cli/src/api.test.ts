// LexaClient — request building + error mapping against a local http server.
// The client takes a base url + api key via constructor injection, so no
// network beyond 127.0.0.1 is touched.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Cause, Either } from "effect";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LexaClient, ApiError, type TaskInfo } from "./api";

interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = "";
const seen: SeenRequest[] = [];

const linkedTask: TaskInfo = {
  id: "t2",
  key: "EG-2",
  title: "Linked",
  priority: null,
  type: null,
  columnId: "open",
  swimlaneId: "sl",
  assignees: null,
  githubs: [{ issueId: "i1", issueNumber: 5, repo: "owner/repo", syncedState: "open", url: "https://github.com/owner/repo/issues/5", outOfSync: false }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const wikiPage = {
  id: "w1",
  projectId: "p1",
  title: "Old Title",
  slug: "old-slug",
  content: { type: "doc", content: [] },
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const columnFixture = {
  id: "c1",
  projectId: "p1",
  name: "Todo",
  position: 0,
  color: null,
  wipLimit: null,
  requiredFields: [],
  githubState: null,
  isDone: false,
};

const swimlaneFixture = {
  id: "l1",
  projectId: "p1",
  name: "Sprint A",
  description: "",
  position: 0,
  dueAt: "2026-06-01",
  archivedAt: null,
  startAt: "2026-05-01",
  kind: "sprint",
  milestoneId: "ms1",
};

const fieldConfigFixture = {
  priorities: [{ id: "pr1", label: "High", color: "#f00", position: 0 }],
  types: [{ id: "ty1", label: "Bug", color: "#00f", position: 0 }],
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const url = req.url ?? "";
    if (url === "/api/health") return json(res, 200, { ok: true });
    if (url === "/api/projects" && req.method === "GET") return json(res, 200, { data: [{ id: "p1", slug: "demo", name: "Demo", description: null }] });
    if (url === "/api/projects" && req.method === "POST") return json(res, 201, { id: "p2", slug: "new", name: "New", description: "d" });
    if (url === "/api/projects/demo" && req.method === "PATCH") return json(res, 200, { id: "p1", slug: "demo", name: "Demo 2", description: null });
    if (url === "/api/projects/demo" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/columns" && req.method === "POST") return json(res, 201, columnFixture);
    if (url === "/api/projects/demo/columns/c1" && req.method === "PATCH") return json(res, 200, columnFixture);
    if (url === "/api/projects/demo/columns/c1" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/swimlanes" && req.method === "POST") return json(res, 201, swimlaneFixture);
    if (url === "/api/projects/demo/swimlanes/l1" && req.method === "PATCH") return json(res, 200, { ...swimlaneFixture, dueAt: null, milestoneId: null });
    if (url === "/api/projects/demo/swimlanes/l1" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/field-config" && req.method === "GET") return json(res, 200, fieldConfigFixture);
    if (url === "/api/projects/demo/field-config" && req.method === "PUT") return json(res, 200, fieldConfigFixture);
    if (url === "/api/settings/rate-limit" && req.method === "GET") return json(res, 200, { max: 6000, windowMs: 600000, envOverride: false });
    if (url === "/api/settings/rate-limit" && req.method === "PUT") return json(res, 200, { max: 100, windowMs: 120000, envOverride: false });
    if (url === "/api/settings/api-keys" && req.method === "GET") return json(res, 200, { data: [{ id: "k1", name: "ci", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null }] });
    if (url === "/api/settings/api-keys" && req.method === "POST") return json(res, 201, { key: { id: "k2", name: "ci", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null }, rawKey: "lxk_" + "a".repeat(43) });
    if (url === "/api/settings/api-keys/k1" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/tasks" && req.method === "POST") return json(res, 201, { data: { id: "t1", title: "New" }, activity: [] });
    if (url === "/api/projects/demo/tasks/t2/github-link" && req.method === "POST") return json(res, 200, { data: linkedTask, activity: [] });
    if (url === "/api/projects/demo/tasks/t2/github-link-existing" && req.method === "POST") return json(res, 200, { data: linkedTask, activity: [] });
    if (url === "/api/projects/demo/tasks/t2/github-link/i1" && req.method === "DELETE") return json(res, 200, { data: linkedTask, activity: [] });
    if (url.startsWith("/api/projects/demo/tasks/t2/github-link/") && req.method === "DELETE") return json(res, 200, { data: linkedTask, activity: [] });
    if (url === "/api/projects/demo/tasks/t3" && req.method === "PATCH") return json(res, 200, { data: { id: "t3", title: "Patched" }, activity: [] });
    if (url === "/api/projects/demo/tasks/t3" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/wiki" && req.method === "POST") return json(res, 201, { ...wikiPage, title: "New Page", slug: "new-page", parentId: "w0" });
    if (url === "/api/projects/demo/wiki/old-slug" && req.method === "PATCH") return json(res, 200, { ...wikiPage, slug: "new-slug", title: "Renamed" });
    if (url === "/api/projects/demo/wiki/old-slug" && req.method === "DELETE") { res.writeHead(204); return res.end(); }
    if (url === "/api/projects/demo/milestones" && req.method === "GET") return json(res, 200, { data: [{ id: "ms1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: "2026-10-01", archivedAt: null, sprintCount: 0, archivedSprintCount: 0 }] });
    if (url === "/api/projects/demo/milestones" && req.method === "POST") return json(res, 201, { id: "ms1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: "2026-10-01", archivedAt: null, sprintCount: 0, archivedSprintCount: 0 });
    if (url === "/api/projects/demo/milestones/ms1" && req.method === "PATCH") return json(res, 200, { id: "ms1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 0, archivedSprintCount: 0 });
    if (url === "/api/projects/demo/tasks/t4/move" && req.method === "POST") return json(res, 200, { data: { id: "t4", title: "Moved" }, activity: [] });
    if (url === "/api/projects/demo/tasks/t1/github-link") return json(res, 409, { error: { code: "ALREADY_LINKED", message: "issue already linked", details: { issueId: "42" } } });
    if (url === "/api/projects/demo/wiki/p1") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("not json {{{"); }
    if (url === "/api/settings/github" && req.method === "GET") return json(res, 200, { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" });
    if (url === "/api/settings/github" && req.method === "PUT") return json(res, 200, { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" });
    return json(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(apiKey = "test-key"): LexaClient {
  return new LexaClient({ url: base, apiKey });
}

// One-off server answering every path with a fixed status/plain-text body —
// for the non-JSON error-mapping cases.
async function plainServer(status: number, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

// runPromise rejects with a FiberFailure wrapper for typed failures — unwrap
// the Cause to get the raw ApiError.
async function failureOf<A, E>(eff: Effect.Effect<A, E, never>): Promise<E> {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Cause.failureOrCause(exit.cause);
  if (Either.isRight(failure)) throw new Error(`unexpected defect: ${String(failure.right)}`);
  return failure.left;
}

describe("LexaClient request building", () => {
  it("200 response parses and sends Bearer auth", async () => {
    const out = await Effect.runPromise(client().health());
    expect(out).toEqual({ ok: true });
    const req = seen[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/health");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("listProjects unwraps the data envelope", async () => {
    const out = await Effect.runPromise(client().listProjects());
    expect(out).toEqual([{ id: "p1", slug: "demo", name: "Demo", description: null }]);
  });

  it("POST sends the JSON body", async () => {
    await Effect.runPromise(client().createTask("demo", { columnId: "c1", swimlaneId: "s1", title: "New" }));
    const req = seen.find((r) => r.url === "/api/projects/demo/tasks");
    expect(req?.method).toBe("POST");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ columnId: "c1", swimlaneId: "s1", title: "New" });
  });

  it("task mutations unwrap the { data, activity } envelope", async () => {
    const out = await Effect.runPromise(client().createTask("demo", { columnId: "c1", swimlaneId: "s1", title: "New" }));
    expect(out).toEqual({ id: "t1", title: "New" });
  });

  it("linkGithubIssue unwraps the { data, activity } envelope to the TaskInfo", async () => {
    const out = await Effect.runPromise(client().linkGithubIssue("demo", "t2", "owner/repo"));
    expect(out).toEqual(linkedTask);
    expect((out as { data?: unknown }).data).toBeUndefined();
    const req = seen.find((r) => r.url === "/api/projects/demo/tasks/t2/github-link");
    expect(req?.method).toBe("POST");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ repo: "owner/repo" });
  });

  it("getGithubSettings GETs /api/settings/github and parses the state", async () => {
    const out = await Effect.runPromise(client().getGithubSettings());
    expect(out).toEqual({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" });
    const req = seen.find((r) => r.url === "/api/settings/github" && r.method === "GET");
    expect(req?.method).toBe("GET");
    expect(req?.headers.authorization).toBe("Bearer test-key");
  });

  it("updateGithubSettings PUTs the body to /api/settings/github", async () => {
    const input = { appId: "123456", privateKey: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n", webhookSecret: "0123456789abcdef" };
    const out = await Effect.runPromise(client().updateGithubSettings(input));
    expect(out.appId).toBe("123456");
    expect(out.privateKeySet).toBe(true);
    expect(out.webhookSecretSet).toBe(true);
    expect(out.source).toBe("db");
    const req = seen.find((r) => r.url === "/api/settings/github" && r.method === "PUT");
    expect(req?.method).toBe("PUT");
    expect(JSON.parse(req?.body ?? "{}")).toEqual(input);
  });

  it("updateGithubSettings sends only the provided optional fields", async () => {
    await Effect.runPromise(client().updateGithubSettings({ appId: "123456" }));
    const req = seen.filter((r) => r.url === "/api/settings/github" && r.method === "PUT");
    const last = req[req.length - 1];
    expect(JSON.parse(last?.body ?? "{}")).toEqual({ appId: "123456" });
  });
});

describe("LexaClient lifecycle writes", () => {
  it("updateTask PATCHes assignees + dueAt", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().updateTask("demo", "t3", { assignees: ["a", "b"], dueAt: "2026-10-01" }));
    expect(out).toEqual({ id: "t3", title: "Patched" });
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo/tasks/t3");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ assignees: ["a", "b"], dueAt: "2026-10-01" });
  });

  it("updateTask sends dueAt: null to clear the deadline", async () => {
    const before = seen.length;
    await Effect.runPromise(client().updateTask("demo", "t3", { dueAt: null }));
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ dueAt: null });
  });

  it("deleteTask DELETEs and resolves undefined on 204", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().deleteTask("demo", "t3"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/tasks/t3");
  });

  it("createWikiPage POSTs { title, parentId } and returns the page", async () => {
    const before = seen.length;
    const page = await Effect.runPromise(client().createWikiPage("demo", { title: "New Page", parentId: "w0" }));
    expect(page.slug).toBe("new-page");
    const req = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/projects/demo/wiki");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ title: "New Page", parentId: "w0" });
  });

  it("updateWikiPage PATCHes a slug rename", async () => {
    const before = seen.length;
    const page = await Effect.runPromise(client().updateWikiPage("demo", "old-slug", { slug: "new-slug" }));
    expect(page.slug).toBe("new-slug");
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo/wiki/old-slug");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ slug: "new-slug" });
  });

  it("deleteWikiPage DELETEs and resolves undefined on 204", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().deleteWikiPage("demo", "old-slug"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/wiki/old-slug");
  });

  it("linkExistingGithubIssue POSTs { repo, issueNumber } and unwraps data", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().linkExistingGithubIssue("demo", "t2", "owner/repo", 7));
    expect(out).toEqual(linkedTask);
    expect((out as { data?: unknown }).data).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "POST");
    expect(req?.url).toBe("/api/projects/demo/tasks/t2/github-link-existing");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ repo: "owner/repo", issueNumber: 7 });
  });

  it("unlinkGithubIssue DELETEs .../github-link/:issueId and unwraps data", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().unlinkGithubIssue("demo", "t2", "i1"));
    expect(out).toEqual(linkedTask);
    expect((out as { data?: unknown }).data).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/tasks/t2/github-link/i1");
  });

  it("unlinkGithubIssue percent-encodes the issueId in the path", async () => {
    const before = seen.length;
    await Effect.runPromise(client().unlinkGithubIssue("demo", "t2", "a/b"));
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/tasks/t2/github-link/a%2Fb");
  });

  it("listMilestones unwraps the data envelope", async () => {
    const out = await Effect.runPromise(client().listMilestones("demo"));
    expect(out.map((m) => m.id)).toEqual(["ms1"]);
  });

  it("createMilestone POSTs { name, dueAt } to /milestones and returns the milestone directly", async () => {
    const before = seen.length;
    const m = await Effect.runPromise(client().createMilestone("demo", { name: "v1", dueAt: "2026-10-01" }));
    expect(m.id).toBe("ms1");
    expect((m as { data?: unknown }).data).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/projects/demo/milestones");
    expect(req?.method).toBe("POST");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "v1", dueAt: "2026-10-01" });
  });

  it("updateMilestone PATCHes .../milestones/:id and sends dueAt: null to clear", async () => {
    const before = seen.length;
    const m = await Effect.runPromise(client().updateMilestone("demo", "ms1", { dueAt: null }));
    expect(m.id).toBe("ms1");
    expect((m as { data?: unknown }).data).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo/milestones/ms1");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ dueAt: null });
  });

  it("moveTask sends beforeTaskId / afterTaskId / clearDueAt through verbatim", async () => {
    const before = seen.length;
    await Effect.runPromise(client().moveTask("demo", "t4", { columnId: "c1", swimlaneId: "s1", beforeTaskId: "NIM-3", clearDueAt: true }));
    const req = seen.slice(before).find((r) => r.method === "POST");
    expect(req?.url).toBe("/api/projects/demo/tasks/t4/move");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ columnId: "c1", swimlaneId: "s1", beforeTaskId: "NIM-3", clearDueAt: true });

    const after = seen.length;
    await Effect.runPromise(client().moveTask("demo", "t4", { columnId: "c1", swimlaneId: "s1", afterTaskId: "NIM-4" }));
    const req2 = seen.slice(after).find((r) => r.method === "POST");
    expect(JSON.parse(req2?.body ?? "{}")).toEqual({ columnId: "c1", swimlaneId: "s1", afterTaskId: "NIM-4" });
  });
});

describe("LexaClient error mapping", () => {
  it("401 without JSON envelope → ApiError status 401, code undefined", async () => {
    const srv = await plainServer(401, "nope");
    try {
      const err = await failureOf(new LexaClient({ url: srv.url, apiKey: "k" }).listProjects());
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(401);
      expect(err.code).toBeUndefined();
      expect(err.message).toBe("HTTP 401");
    } finally {
      await srv.close();
    }
  });

  it("409 with {error:{code,message,details}} → typed ApiError fields", async () => {
    const err = await failureOf(client().linkGithubIssue("demo", "t1", "owner/repo"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("ALREADY_LINKED");
    expect(err.serverMessage).toBe("issue already linked");
    expect(err.details).toEqual({ issueId: "42" });
    expect(err.message).toBe("issue already linked");
    expect(err._tag).toBe("ApiError");
  });

  it("500 with plain-text body → status 500, fallback message", async () => {
    const srv = await plainServer(500, "boom");
    try {
      const err = await failureOf(new LexaClient({ url: srv.url, apiKey: "k" }).health());
      expect(err.status).toBe(500);
      expect(err.serverMessage).toBeUndefined();
      expect(err.message).toBe("HTTP 500");
    } finally {
      await srv.close();
    }
  });

  it("malformed JSON on 200 → normalized ApiError status 0", async () => {
    const err = await failureOf(client().getWikiPage("demo", "p1"));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Unexpected/);
  });

  it("network failure (connection refused) → ApiError status 0 with fetch message", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const err = await failureOf(new LexaClient({ url: `http://127.0.0.1:${port}`, apiKey: "k" }).health());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("hanging server rejects with ApiError status 0 at the request timeout", async () => {
    const hanging = createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const port = (hanging.address() as AddressInfo).port;
    // Real deadline is 30s; shrink it to 10ms so the test fails fast while the
    // spy still records the production timeout value.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(Math.min(ms, 10)));
    try {
      const err = await failureOf(new LexaClient({ url: `http://127.0.0.1:${port}`, apiKey: "k" }).health());
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(0);
      expect(spy).toHaveBeenCalledWith(30_000);
    } finally {
      spy.mockRestore();
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("404 with envelope → code NOT_FOUND", async () => {
    const err = await failureOf(client().listSwimlanes("nope"));
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("LexaClient admin + settings", () => {
  it("createProject POSTs the payload to /api/projects", async () => {
    const before = seen.length;
    const project = await Effect.runPromise(client().createProject({ name: "New", slug: "new", description: "d", teamId: "t1" }));
    expect(project.slug).toBe("new");
    const req = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/projects");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "New", slug: "new", description: "d", teamId: "t1" });
  });

  it("updateProject PATCHes /api/projects/:slug", async () => {
    const before = seen.length;
    const project = await Effect.runPromise(client().updateProject("demo", { name: "Demo 2" }));
    expect(project.name).toBe("Demo 2");
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "Demo 2" });
  });

  it("deleteProject DELETEs .../:slug and resolves undefined on 204", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().deleteProject("demo"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo");
  });

  it("createColumn POSTs the payload including explicit nulls", async () => {
    const before = seen.length;
    const column = await Effect.runPromise(client().createColumn("demo", { name: "Todo", wipLimit: null, githubState: null }));
    expect(column.id).toBe("c1");
    const req = seen.slice(before).find((r) => r.method === "POST");
    expect(req?.url).toBe("/api/projects/demo/columns");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "Todo", wipLimit: null, githubState: null });
  });

  it("updateColumn PATCHes .../columns/:id with wipLimit:null", async () => {
    const before = seen.length;
    await Effect.runPromise(client().updateColumn("demo", "c1", { wipLimit: null }));
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo/columns/c1");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ wipLimit: null });
  });

  it("deleteColumn DELETEs .../columns/:id", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().deleteColumn("demo", "c1"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/columns/c1");
  });

  it("createSwimlane POSTs the payload to .../swimlanes", async () => {
    const before = seen.length;
    const lane = await Effect.runPromise(client().createSwimlane("demo", { name: "Sprint A", milestoneId: "ms1" }));
    expect(lane.id).toBe("l1");
    const req = seen.slice(before).find((r) => r.method === "POST");
    expect(req?.url).toBe("/api/projects/demo/swimlanes");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "Sprint A", milestoneId: "ms1" });
  });

  it("updateSwimlane PATCHes .../swimlanes/:id with dueAt:null and milestoneId:null", async () => {
    const before = seen.length;
    await Effect.runPromise(client().updateSwimlane("demo", "l1", { dueAt: null, milestoneId: null }));
    const req = seen.slice(before).find((r) => r.method === "PATCH");
    expect(req?.url).toBe("/api/projects/demo/swimlanes/l1");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ dueAt: null, milestoneId: null });
  });

  it("deleteSwimlane DELETEs .../swimlanes/:id", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().deleteSwimlane("demo", "l1"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/projects/demo/swimlanes/l1");
  });

  it("putFieldConfig PUTs the wholesale payload", async () => {
    const before = seen.length;
    const input = { priorities: [{ label: "Low", color: "#0f0", position: 0 }], types: [] };
    const out = await Effect.runPromise(client().putFieldConfig("demo", input));
    expect(out.priorities.length).toBe(1);
    const req = seen.slice(before).find((r) => r.method === "PUT");
    expect(req?.url).toBe("/api/projects/demo/field-config");
    expect(JSON.parse(req?.body ?? "{}")).toEqual(input);
  });

  it("getRateLimit GETs /api/settings/rate-limit", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().getRateLimit());
    expect(out).toEqual({ max: 6000, windowMs: 600000, envOverride: false });
    expect(seen.slice(before).some((r) => r.method === "GET" && r.url === "/api/settings/rate-limit")).toBe(true);
  });

  it("putRateLimit PUTs { max, windowMs }", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().putRateLimit({ max: 100, windowMs: 120000 }));
    expect(out.max).toBe(100);
    const req = seen.slice(before).find((r) => r.method === "PUT" && r.url === "/api/settings/rate-limit");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ max: 100, windowMs: 120000 });
  });

  it("listSettingsApiKeys unwraps the data envelope", async () => {
    const out = await Effect.runPromise(client().listSettingsApiKeys());
    expect(out.map((k) => k.id)).toEqual(["k1"]);
    expect((out[0] as { rawKey?: unknown }).rawKey).toBeUndefined();
  });

  it("createSettingsApiKey POSTs { name } and returns key + rawKey", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().createSettingsApiKey({ name: "ci" }));
    expect(out.rawKey).toMatch(/^lxk_/);
    const req = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/settings/api-keys");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "ci" });
  });

  it("revokeSettingsApiKey DELETEs .../api-keys/:id", async () => {
    const before = seen.length;
    const out = await Effect.runPromise(client().revokeSettingsApiKey("k1"));
    expect(out).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "DELETE");
    expect(req?.url).toBe("/api/settings/api-keys/k1");
  });
});
