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
    if (url === "/api/projects") return json(res, 200, { data: [{ id: "p1", slug: "demo", name: "Demo", description: null }] });
    if (url === "/api/projects/demo/tasks" && req.method === "POST") return json(res, 201, { data: { id: "t1", title: "New" }, activity: [] });
    if (url === "/api/projects/demo/tasks/t2/github-link" && req.method === "POST") return json(res, 200, { data: linkedTask, activity: [] });
    if (url === "/api/hearth/runtimes" && req.method === "GET") { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("nope"); }
    if (url === "/api/projects/demo/tasks/t1/github-link") return json(res, 409, { error: { code: "ALREADY_LINKED", message: "issue already linked", details: { issueId: "42" } } });
    if (url === "/api/hearth/machines/heartbeat") { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("boom"); }
    if (url === "/api/projects/demo/wiki/p1") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("not json {{{"); }
    if (url === "/api/hearth/runtimes/r1" && req.method === "DELETE") return res.writeHead(204).end();
    if (url === "/api/hearth/runtime-events/claim") return json(res, 200, { event: null });
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

  it("claimRuntimeEvent sends x-machine-secret", async () => {
    const out = await Effect.runPromise(client().claimRuntimeEvent("m1", "s3cret"));
    expect(out).toEqual({ event: null });
    const req = seen.find((r) => r.url === "/api/hearth/runtime-events/claim");
    expect(req?.headers["x-machine-secret"]).toBe("s3cret");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ machineId: "m1" });
  });

  it("204 maps to undefined (deleteRuntime)", async () => {
    const out = await Effect.runPromise(client().deleteRuntime("r1"));
    expect(out).toBeUndefined();
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

describe("LexaClient error mapping", () => {
  it("401 without JSON envelope → ApiError status 401, code undefined", async () => {
    const err = await failureOf(client().listRuntimes());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe("HTTP 401");
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
    const err = await failureOf(client().machineHeartbeat({ id: "m1", hostname: "h" }));
    expect(err.status).toBe(500);
    expect(err.serverMessage).toBeUndefined();
    expect(err.message).toBe("HTTP 500");
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
