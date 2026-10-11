// CliConfigService — group-keyed ~/.lexa/<host>/config.json (login + deploy
// creds) and the legacy migrations. LEXA_DIR and HOME are read at module load
// (LEGACY_PATHS is bound from os.homedir() at import time), so every test
// redirects BOTH env vars to fresh tmp dirs before re-importing the module
// via dynamic import. Node's os.homedir() reads $HOME on every call (verified
// node 22: in-process changes are honored), so the beforeEach redirect binds
// the legacy dirs to the tmp HOME and the migrations never touch the real
// ~/.config/lexa-* or ~/.lexa-* dirs.
//
// LexaClient (formerly cli/src/api.test.ts) is folded in here: request
// building + error mapping against a local http server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Context, Exit, Cause, Either } from "effect";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliConfigService } from "./config";
import { LexaClient, ApiError, type TaskInfo } from "./api";

let homeDir = "";
let dir = "";

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lexa-config-home-"));
  dir = mkdtempSync(join(tmpdir(), "lexa-config-test-"));
  process.env.HOME = homeDir;
  process.env.LEXA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.LEXA_DIR;
  vi.restoreAllMocks();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function loadService(): Promise<CliConfigService> {
  const mod = await import("./config");
  const ctx = Effect.runSync(Effect.scoped(Layer.build(mod.CliConfigService.Default)));
  return Context.get(ctx, mod.CliConfigService);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// The group dir a saved login for this url would live in (module LEXA_DIR is
// bound to the tmp `dir` from the beforeEach redirect).
async function groupFor(url: string): Promise<string> {
  const { groupDir } = await import("./config");
  return groupDir(url);
}

describe("resolveServerUrl", () => {
  it("preserves an explicit http(s) scheme, strips the trailing slash, defaults to https", async () => {
    const { resolveServerUrl } = await import("./config");
    expect(resolveServerUrl("http://lexa.example.com")).toBe("http://lexa.example.com");
    expect(resolveServerUrl("https://lexa.example.com/")).toBe("https://lexa.example.com");
    expect(resolveServerUrl("HTTPS://Lexa.Example.Com/")).toBe("HTTPS://Lexa.Example.Com");
    expect(resolveServerUrl("lexa.example.com")).toBe("https://lexa.example.com");
    expect(resolveServerUrl("  lexa.example.com:8443  ")).toBe("https://lexa.example.com:8443");
  });

  it("uses http for loopback hosts (bare, ported, IPv6) and strips userinfo when classifying", async () => {
    const { resolveServerUrl } = await import("./config");
    expect(resolveServerUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(resolveServerUrl("127.0.0.1:8794")).toBe("http://127.0.0.1:8794");
    expect(resolveServerUrl("127.0.0.5")).toBe("http://127.0.0.5");
    expect(resolveServerUrl("[::1]:3000")).toBe("http://[::1]:3000");
    expect(resolveServerUrl("::1")).toBe("http://[::1]");
    expect(resolveServerUrl("user:pass@localhost:3000")).toBe("http://user:pass@localhost:3000");
    expect(resolveServerUrl("user:pass@localhost:3000/")).toBe("http://user:pass@localhost:3000");
    expect(resolveServerUrl("user:pass@127.0.0.1:3000")).toBe("http://user:pass@127.0.0.1:3000");
    // Userinfo alone never makes a remote host loopback.
    expect(resolveServerUrl("user:pass@example.com")).toBe("https://user:pass@example.com");
  });
});

describe("CliConfigService", () => {
  it("saveConfig writes chmod 600 and round-trips; loadConfig is null when missing/corrupt/incomplete", async () => {
    const svc = await loadService();
    const g = await groupFor("http://example.com:3000");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com:3000///", apiKey: "lxk_abc" }, g));
    const path = join(g, "config.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "http://example.com:3000", apiKey: "lxk_abc" });
    expect(mode(path)).toBe(0o600);
    expect(await Effect.runPromise(svc.loadConfig(g))).toEqual({ url: "http://example.com:3000", apiKey: "lxk_abc" });

    expect(await Effect.runPromise(svc.loadConfig(await groupFor("http://missing.example.com")))).toBeNull();

    const corrupt = await groupFor("http://corrupt.example.com");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "config.json"), "{not json");
    expect(await Effect.runPromise(svc.loadConfig(corrupt))).toBeNull();

    const incomplete = await groupFor("http://incomplete.example.com");
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(incomplete, "config.json"), JSON.stringify({ url: "http://incomplete.example.com" }));
    expect(await Effect.runPromise(svc.loadConfig(incomplete))).toBeNull();
  });
});

describe("migrateLegacyDirs (retargeted to groups)", () => {
  it("moves legacy ~/.config state into the config-url group; an existing group wins and the legacy copy is deleted", async () => {
    const legacyCli = join(homeDir, ".config", "lexa-cli");
    const legacyForge = join(homeDir, ".config", "lexa-forge");
    mkdirSync(legacyCli, { recursive: true });
    mkdirSync(legacyForge, { recursive: true });
    writeFileSync(join(legacyCli, "config.json"), JSON.stringify({ url: "http://legacy.example.com", apiKey: "k" }));
    writeFileSync(join(legacyCli, "machine-id"), "host-1\n");
    writeFileSync(join(legacyForge, "env"), "LEXA_URL=http://legacy.example.com\n");
    writeFileSync(join(legacyForge, "runtimes"), "{}");
    const group = join(dir, "legacy.example.com");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());

    expect(readFileSync(join(group, "config.json"), "utf-8")).toBe(JSON.stringify({ url: "http://legacy.example.com", apiKey: "k" }));
    expect(readFileSync(join(group, "machine-id"), "utf-8")).toBe("host-1\n");
    expect(readFileSync(join(group, "env"), "utf-8")).toBe("LEXA_URL=http://legacy.example.com\n");
    expect(readFileSync(join(group, "runtimes"), "utf-8")).toBe("{}");
    // Sources are gone (no fallback) — parents may linger empty under node.
    expect(existsSync(join(legacyCli, "config.json"))).toBe(false);
    expect(existsSync(join(legacyCli, "machine-id"))).toBe(false);
    expect(readdirSync(legacyCli).length).toBe(0);
    expect(existsSync(join(legacyForge, "env"))).toBe(false);
    expect(existsSync(join(legacyForge, "runtimes"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Migrated legacy"));
    log.mockRestore();

    const existingCli = join(homeDir, ".config", "lexa-cli");
    mkdirSync(existingCli, { recursive: true });
    writeFileSync(join(existingCli, "config.json"), JSON.stringify({ url: "http://legacy.example.com", apiKey: "old" }));
    mkdirSync(group, { recursive: true });
    writeFileSync(join(group, "config.json"), JSON.stringify({ url: "http://new", apiKey: "new" }));
    const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc2 = await loadService();
    await Effect.runPromise(svc2.migrateLegacyDirs());
    expect(JSON.parse(readFileSync(join(group, "config.json"), "utf-8"))).toEqual({ url: "http://new", apiKey: "new" });
    expect(existsSync(join(existingCli, "config.json"))).toBe(false);
    expect(readdirSync(existingCli).length).toBe(0);
    log2.mockRestore();
  });
});

describe("migrateFlavorRoots (legacy flavor roots → groups)", () => {
  // Runs only when LEXA_DIR is UNSET — the module then binds LEXA_DIR to
  // ~/.lexa under the redirected tmp HOME.
  async function loadServiceWithoutLexaDir(): Promise<CliConfigService> {
    delete process.env.LEXA_DIR;
    vi.resetModules();
    return loadService();
  }

  const root = () => join(homeDir, ".lexa");

  it("moves ~/.lexa-dev into its group, is idempotent, and does nothing when LEXA_DIR is set", async () => {
    const dev = join(homeDir, ".lexa-dev");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "config.json"), JSON.stringify({ url: "http://localhost:3000", apiKey: "k" }));
    writeFileSync(join(dev, "machine-id"), "host-dev\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(readFileSync(join(root(), "localhost:3000", "config.json"), "utf-8")).toBe(JSON.stringify({ url: "http://localhost:3000", apiKey: "k" }));
    expect(readFileSync(join(root(), "localhost:3000", "machine-id"), "utf-8")).toBe("host-dev\n");
    expect(existsSync(dev)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("moved"));
    log.mockRestore();

    const staging = join(homeDir, ".lexa-staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "config.json"), JSON.stringify({ url: "https://lexa-preview.example.com", apiKey: "k" }));
    writeFileSync(join(staging, "machine-id"), "host-stage\n");
    const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc2 = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc2.migrateFlavorRoots());
    log2.mockReset();
    await Effect.runPromise(svc2.migrateFlavorRoots());
    expect(log2).not.toHaveBeenCalledWith(expect.stringContaining("Migration: moved"));
    expect(existsSync(join(root(), "lexa-preview.example.com", "machine-id"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    log2.mockRestore();

    const kept = join(homeDir, ".lexa-dev2");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "config.json"), JSON.stringify({ url: "http://localhost:3000", apiKey: "k" }));
    // LEXA_DIR is still set by the outer beforeEach.
    const svc3 = await loadService();
    await Effect.runPromise(svc3.migrateFlavorRoots());
    expect(existsSync(join(kept, "config.json"))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("LexaClient (request building + error mapping)", () => {
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

  const clock = "2026-01-01T00:00:00Z";
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
    createdAt: clock,
    updatedAt: clock,
  };
  const milestone = { id: "ms1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: "2026-10-01", archivedAt: null, sprintCount: 0, archivedSprintCount: 0 };

  function readBody(req: IncomingMessage): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    return promise;
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
      if (url === "/api/projects/demo/tasks" && req.method === "POST") return json(res, 201, { data: { id: "t1", title: "New" }, activity: [] });
      if (url === "/api/projects/demo/tasks/t2/github-link" && req.method === "POST") return json(res, 200, { data: linkedTask, activity: [] });
      if (url === "/api/projects/demo/tasks/t2/github-link/i1" && req.method === "DELETE") return json(res, 200, { data: linkedTask, activity: [] });
      if (url === "/api/projects/demo/wiki" && req.method === "POST") return json(res, 201, { ...wikiPage, title: "New Page", slug: "new-page", parentId: "w0" });
      if (url === "/api/projects/demo/wiki/old-slug" && req.method === "PATCH") return json(res, 200, { ...wikiPage, title: "Renamed", slug: "new-slug" });
      if (url === "/api/projects/demo/milestones" && req.method === "GET") return json(res, 200, { data: [milestone] });
      if (url === "/api/projects/demo/milestones" && req.method === "POST") return json(res, 201, milestone);
      if (url === "/api/projects/demo/tasks/t1/github-link") return json(res, 409, { error: { code: "ALREADY_LINKED", message: "issue already linked", details: { issueId: "42" } } });
      if (url === "/api/projects/demo/wiki/p1") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end("not json {{{"); }
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

  it("sends Bearer auth + JSON content type and parses a 200", async () => {
    const out = await Effect.runPromise(client().health());
    expect(out).toEqual({ ok: true });
    const req = seen[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api/health");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("unwraps the {data} and {data,activity} envelopes", async () => {
    expect(await Effect.runPromise(client().listProjects())).toEqual([{ id: "p1", slug: "demo", name: "Demo", description: null }]);
    const created = await Effect.runPromise(client().createTask("demo", { columnId: "c1", swimlaneId: "s1", title: "New" }));
    expect(created).toEqual({ id: "t1", title: "New" });
    const linked = await Effect.runPromise(client().linkGithubIssue("demo", "t2", "owner/repo"));
    expect(linked).toEqual(linkedTask);
    expect((linked as { data?: unknown }).data).toBeUndefined();
  });

  it("maps 401 plain, 409 enveloped and 500 plain responses onto ApiError", async () => {
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

    const typed = await failureOf(client().linkGithubIssue("demo", "t1", "owner/repo"));
    expect(typed).toBeInstanceOf(ApiError);
    expect(typed.status).toBe(409);
    expect(typed.code).toBe("ALREADY_LINKED");
    expect(typed.serverMessage).toBe("issue already linked");
    expect(typed.details).toEqual({ issueId: "42" });
    expect(typed.message).toBe("issue already linked");
    expect(typed._tag).toBe("ApiError");

    const srv500 = await plainServer(500, "boom");
    try {
      const err = await failureOf(new LexaClient({ url: srv500.url, apiKey: "k" }).health());
      expect(err.status).toBe(500);
      expect(err.serverMessage).toBeUndefined();
      expect(err.message).toBe("HTTP 500");
    } finally {
      await srv500.close();
    }
  });

  it("normalizes transport failures to ApiError status 0 (malformed JSON, refused, timeout)", async () => {
    const malformed = await failureOf(client().getWikiPage("demo", "p1"));
    expect(malformed).toBeInstanceOf(ApiError);
    expect(malformed.status).toBe(0);
    expect(malformed.message).toMatch(/Unexpected/);

    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const refused = await failureOf(new LexaClient({ url: `http://127.0.0.1:${port}`, apiKey: "k" }).health());
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused.status).toBe(0);
    expect(refused.message.length).toBeGreaterThan(0);

    const hanging = createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hangPort = (hanging.address() as AddressInfo).port;
    // Real deadline is 30s; shrink it to 10ms so the test fails fast while the
    // spy still records the production timeout value.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => realTimeout(Math.min(ms, 10)));
    try {
      const timedOut = await failureOf(new LexaClient({ url: `http://127.0.0.1:${hangPort}`, apiKey: "k" }).health());
      expect(timedOut).toBeInstanceOf(ApiError);
      expect(timedOut.status).toBe(0);
      expect(spy).toHaveBeenCalledWith(30_000);
    } finally {
      spy.mockRestore();
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("forwards the right verb/path/payload for wiki + github-link mutations", async () => {
    let before = seen.length;
    await Effect.runPromise(client().unlinkGithubIssue("demo", "t2", "i1"));
    expect(seen.slice(before).find((r) => r.method === "DELETE")?.url).toBe("/api/projects/demo/tasks/t2/github-link/i1");

    before = seen.length;
    const page = await Effect.runPromise(client().createWikiPage("demo", { title: "New Page", parentId: "w0" }));
    expect(page.slug).toBe("new-page");
    const post = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/projects/demo/wiki");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ title: "New Page", parentId: "w0" });

    before = seen.length;
    const renamed = await Effect.runPromise(client().updateWikiPage("demo", "old-slug", { slug: "new-slug" }));
    expect(renamed.slug).toBe("new-slug");
    const patch = seen.slice(before).find((r) => r.method === "PATCH");
    expect(patch?.url).toBe("/api/projects/demo/wiki/old-slug");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ slug: "new-slug" });
  });

  it("lists then creates milestones (direct return, not enveloped)", async () => {
    expect((await Effect.runPromise(client().listMilestones("demo"))).map((m) => m.id)).toEqual(["ms1"]);
    const before = seen.length;
    const m = await Effect.runPromise(client().createMilestone("demo", { name: "v1", dueAt: "2026-10-01" }));
    expect(m.id).toBe("ms1");
    expect((m as { data?: unknown }).data).toBeUndefined();
    const req = seen.slice(before).find((r) => r.method === "POST" && r.url === "/api/projects/demo/milestones");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ name: "v1", dueAt: "2026-10-01" });
  });
});
