// hearth/daemon.ts process-bound integration: the REAL daemon as a bun
// subprocess against a fake Lexa server and a fake agent CLI. The agent
// echoes its env — proving the closed whitelist end-to-end (the daemon's
// secrets must never reach the child) and the exit-3 auth-failure relay.
// The fake server + agent live in-process, so the daemon is spawned async
// (spawnSync would block this worker's event loop and the server could never
// accept connections).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleServe, runHttpTask, type HttpRunOptions } from "./daemon";
import { Effect } from "effect";

interface FakeAgentResponse {
  task: {
    id: string;
    projectId: string;
    documentType: "task" | "wiki";
    documentId: string;
    agentId: string;
    agentName: string;
    skillId: string;
    skillName: string;
    selection: string;
    docContext: string;
    status: string;
    result: string | null;
    error: string | null;
  } | null;
  provider: string;
  agent: string;
  model: string;
  printLogs: boolean;
  logLevel: string;
  extraArgs: string[];
  prompt: string;
  agentMarkdown: string;
  skillMarkdown: string;
  skillIds: string[];
}

function emptyClaim(taskId: string): FakeAgentResponse {
  return {
    task: taskId
      ? {
          id: taskId,
          projectId: "p1",
          documentType: "task",
          documentId: "d1",
          agentId: "lexa",
          agentName: "Lexa",
          skillId: "hearth",
          skillName: "Hearth",
          selection: "",
          docContext: "context",
          status: "running",
          result: null,
          error: null,
        }
      : null,
    provider: "command-code",
    agent: "",
    model: "",
    printLogs: false,
    logLevel: "",
    extraArgs: [],
    prompt: "prove the env scrubbing",
    agentMarkdown: "",
    skillMarkdown: "",
    skillIds: [],
  };
}

describe("hearth daemon (bun subprocess, fake server + fake agent)", () => {
  let dir = "";
  let home = "";
  let agentScript = "";
  let server: Server;
  let base = "";
  let registerStatus = 200;
  const completes: Array<{ url: string; body: Record<string, unknown> }> = [];

  async function startFakeServer(): Promise<void> {
    completes.length = 0;
    registerStatus = 200;
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const url = req.url ?? "";
      if (url === "/api/hearth/runtimes/register") {
        if (registerStatus !== 200) {
          res.writeHead(registerStatus, { "Content-Type": "text/plain" });
          res.end("nope");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "r-test" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url === "/api/hearth/daemon/claim") {
        const haveTask = completes.length === 0;
        res.end(JSON.stringify(emptyClaim(haveTask ? "t1" : "")));
      } else if (url.startsWith("/api/hearth/daemon/tasks/") && url.endsWith("/complete")) {
        completes.push({ url, body: JSON.parse(body) as Record<string, unknown> });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.startsWith("/api/hearth/daemon/tasks/") && url.endsWith("/status")) {
        res.end(JSON.stringify({ status: "running" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lexa-daemon-lexa-"));
    home = mkdtempSync(join(tmpdir(), "lexa-daemon-home-"));
    agentScript = join(dir, "fake-agent.sh");
    writeFileSync(
      agentScript,
      [
        "#!/bin/sh",
        'echo "PATH=${PATH:+present}"',
        'echo "HOME=$HOME"',
        'echo "PWD=$PWD"',
        'echo "LEXA_API_KEY=${LEXA_API_KEY:-ABSENT}"',
        'echo "LXK_HEARTH_DAEMON_TOKEN=${LXK_HEARTH_DAEMON_TOKEN:-ABSENT}"',
        'echo "LEXA_URL=${LEXA_URL:-ABSENT}"',
        'echo "HEARTH_POLL_MS=${HEARTH_POLL_MS:-ABSENT}"',
        'echo "HEARTH_CMD_BIN=${HEARTH_CMD_BIN:-ABSENT}"',
        'echo "HEARTH_AGENT=${HEARTH_AGENT:-ABSENT}"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(agentScript, 0o755);
    await startFakeServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function spawnDaemon(): ReturnType<typeof spawn> {
    return spawn("bun", ["hearth/daemon.ts"], {
      cwd: join(import.meta.dirname ?? ".", ".."),
      env: {
        ...process.env,
        LEXA_URL: base,
        LEXA_API_KEY: "lxk_daemon_key_1234567890123456789012345678901234567890",
        LXK_HEARTH_DAEMON_TOKEN: "plain-shared-secret",
        HEARTH_AGENT: "command-code",
        HEARTH_CMD_BIN: agentScript,
        HEARTH_MACHINE_ID: "m-test",
        HEARTH_POLL_MS: "100",
        LEXA_DIR: dir,
        HOME: home,
      },
    });
  }

  function waitFor<T>(probe: () => T | undefined, deadlineMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const value = probe();
        if (value !== undefined) return resolve(value);
        if (Date.now() - start > deadlineMs) return reject(new Error("timed out waiting for daemon activity"));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  it("the agent child never sees daemon secrets — closed whitelist end-to-end", async () => {
    const daemon = spawnDaemon();
    let daemonStderr = "";
    daemon.stderr?.on("data", (d: Buffer) => (daemonStderr += d.toString()));
    try {
      const complete = await waitFor(() => completes[0]!);
      expect(complete.url).toContain("/api/hearth/daemon/tasks/t1/complete");
      const result = String(complete.body.result ?? "");
      // Allowlisted vars reach the child...
      expect(result).toContain("PATH=present");
      expect(result).toContain(`HOME=${home}`);
      expect(result).toContain("PWD=");
      // ...but every Lexa credential and daemon config var is scrubbed.
      expect(result).toContain("LEXA_API_KEY=ABSENT");
      expect(result).toContain("LXK_HEARTH_DAEMON_TOKEN=ABSENT");
      expect(result).toContain("LEXA_URL=ABSENT");
      expect(result).toContain("HEARTH_POLL_MS=ABSENT");
      expect(result).toContain("HEARTH_CMD_BIN=ABSENT");
      expect(result).toContain("HEARTH_AGENT=ABSENT");
    } finally {
      daemon.kill("SIGKILL");
    }
    expect(daemonStderr).not.toContain("Fatal:");
  }, 30_000);

  it("exits 3 when the server rejects the credential (revoked API key)", async () => {
    registerStatus = 401;
    const exit = await new Promise<number | null>((resolve, reject) => {
      const daemon = spawnDaemon();
      let stderr = "";
      daemon.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => {
        daemon.kill("SIGKILL");
        reject(new Error("daemon did not exit after 401"));
      }, 15_000);
      daemon.on("close", (code) => {
        clearTimeout(timer);
        if (code === 3) resolve(code);
        else reject(new Error(`expected exit 3, got ${code}; stderr: ${stderr.slice(0, 400)}`));
      });
    });
    expect(exit).toBe(3);
  }, 30_000);
});

describe("sweepStaleServe", () => {
  it("kills the stale serve pid from serve.pid and deletes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-serve-sweep-"));
    try {
      const dummy = spawn("bun", ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      const pid = await new Promise<number | undefined>((resolve) => {
        dummy.once("spawn", () => resolve(dummy.pid));
        dummy.once("error", () => resolve(undefined));
      });
      expect(pid).toBeDefined();
      const pidPath = join(dir, "runtimes", "rt-x", "serve.pid");
      mkdirSync(join(dir, "runtimes", "rt-x"), { recursive: true });
      writeFileSync(pidPath, String(pid));
      const exited = new Promise<number | null>((resolve) => dummy.once("close", (code) => resolve(code)));
      sweepStaleServe("rt-x", dir);
      await exited;
      expect(existsSync(pidPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("runHttpTask against a local fixture", () => {
  let server: Server;
  let base = "";

  beforeEach(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && url.pathname === "/session/s1/message") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body) as { parts?: Array<{ type: string; text: string }> };
        if (parsed.parts?.[0]?.text === "boom") {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { name: "BadRequest", data: { message: "boom: rejected" } } }));
          return;
        }
        res.end(JSON.stringify({ parts: [{ type: "step-start" }, { type: "text", text: "## A" }, { type: "text", text: "line" }, { type: "step-finish" }], error: null }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { name: "NotFound" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function opts(port: number): HttpRunOptions {
    return {
      port,
      sessionId: "s1",
      model: "opencode-go/deepseek-v4-flash",
      agent: "build",
      prompt: "hi",
      taskId: "t-http",
      mapping: { documentType: "task", documentId: "d1", runtimeId: "rt-x" },
      pollMs: 500,
    };
  }

  it("posts the message with an object model and joins the text parts", async () => {
    const port = (server.address() as AddressInfo).port;
    const result = await Effect.runPromise(runHttpTask(opts(port)));
    expect(result).toBe("## A\nline");
  });

  it("fails the task when serve returns an error response", async () => {
    const port = (server.address() as AddressInfo).port;
    const failure = await Effect.runPromise(runHttpTask({ ...opts(port), prompt: "boom" }).pipe(Effect.flip));
    expect(failure.message).toContain("boom: rejected");
  });
});

describe("hearth daemon (bun subprocess) with a fake opencode serve runtime", () => {
  interface ServeEvent {
    event: string;
    args?: string[];
    directory?: string;
    body?: Record<string, unknown>;
  }

  let dir = "";
  let home = "";
  let servePort = 0;
  let fakeLexa: Server;
  let lexaBase = "";
  const sessionsPuts: Array<{ body: Record<string, unknown> }> = [];
  const sessionsDeletes: Array<{ body: Record<string, unknown> }> = [];
  const completes: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fails: Array<{ url: string; body: Record<string, unknown> }> = [];
  let claimed = false;

  function readServeEvents(): ServeEvent[] {
    const path = join(dir, "serve-events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ServeEvent);
  }

  async function startFakeLexa(): Promise<void> {
    claimed = false;
    sessionsPuts.length = 0;
    sessionsDeletes.length = 0;
    completes.length = 0;
    fails.length = 0;
    fakeLexa = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const url = req.url ?? "";
      if (url === "/api/hearth/runtimes/register") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "r-test" }));
        return;
      }
      if (url === "/api/hearth/daemon/claim") {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!claimed) {
          claimed = true;
          res.end(JSON.stringify({
            task: {
              id: "t-oc", projectId: "p1", documentType: "task", documentId: "d1",
              agentId: "lexa", agentName: "Lexa", skillId: "hearth", skillName: "Hearth",
              selection: "", docContext: "ctx", status: "running", result: null, error: null,
            },
            provider: "opencode", agent: "build", model: "opencode-go/deepseek-v4-flash",
            printLogs: false, logLevel: "", extraArgs: [],
            prompt: "write the docs", agentMarkdown: "", skillMarkdown: "", skillIds: [],
            repoContent: null, runtimeSessionId: null,
          }));
        } else {
          res.end(JSON.stringify({ task: null, provider: "opencode", agent: "", model: "", printLogs: false, logLevel: "", extraArgs: [], prompt: "", agentMarkdown: "", skillMarkdown: "", skillIds: [], repoContent: null, runtimeSessionId: null }));
        }
        return;
      }
      if (url === "/api/hearth/sessions" && req.method === "PUT") {
        sessionsPuts.push({ body: JSON.parse(body) as Record<string, unknown> });
        res.writeHead(204);
        res.end();
        return;
      }
      if (url === "/api/hearth/sessions" && req.method === "DELETE") {
        sessionsDeletes.push({ body: JSON.parse(body) as Record<string, unknown> });
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith("/api/hearth/daemon/tasks/") && url.endsWith("/status")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "cancelled" }));
        return;
      }
      if (url.startsWith("/api/hearth/daemon/tasks/") && url.endsWith("/complete")) {
        completes.push({ url, body: JSON.parse(body) as Record<string, unknown> });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.startsWith("/api/hearth/daemon/tasks/") && url.endsWith("/fail")) {
        fails.push({ url, body: JSON.parse(body) as Record<string, unknown> });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => fakeLexa.listen(0, "127.0.0.1", resolve));
    lexaBase = `http://127.0.0.1:${(fakeLexa.address() as AddressInfo).port}`;
  }

  function waitFor<T>(probe: () => T | undefined, deadlineMs = 20_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const value = probe();
        if (value !== undefined) return resolve(value);
        if (Date.now() - start > deadlineMs) return reject(new Error("timed out waiting for daemon activity"));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function spawnDaemon(): ReturnType<typeof spawn> {
    return spawn("bun", ["hearth/daemon.ts"], {
      cwd: join(import.meta.dirname ?? ".", ".."),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        LEXA_URL: lexaBase,
        LEXA_API_KEY: "lxk_daemon_key_1234567890123456789012345678901234567890",
        HEARTH_AGENT: "opencode",
        HEARTH_MACHINE_ID: "m-test",
        HEARTH_POLL_MS: "100",
        HEARTH_SERVE_PORT: String(servePort),
        LEXA_DIR: dir,
        HOME: home,
      },
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lexa-serve-daemon-"));
    home = mkdtempSync(join(tmpdir(), "lexa-serve-home-"));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    servePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    writeFileSync(
      join(dir, "opencode"),
      ["#!/bin/sh", 'DIR="$(dirname "$0")"', 'exec bun "$DIR/fake-serve.ts" "$@"'].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "opencode"), 0o755);
    writeFileSync(
      join(dir, "fake-serve.ts"),
      [
        'import { appendFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const args = process.argv.slice(2);",
        "const port = Number(args[args.indexOf(\"--port\") + 1]);",
        "const events = join(import.meta.dir, \"serve-events.jsonl\");",
        "const record = (e: unknown) => appendFileSync(events, JSON.stringify(e) + \"\\n\");",
        'record({ event: "spawn", args });',
        "Bun.serve({",
        '  hostname: "127.0.0.1",',
        "  port,",
        "  async fetch(req) {",
        "    const url = new URL(req.url);",
        '    if (req.method === "GET" && url.pathname === "/session") return Response.json({ ok: true });',
        '    if (req.method === "POST" && url.pathname === "/session") {',
        '      const directory = url.searchParams.get("directory") ?? "";',
        '      record({ event: "mint", directory });',
        '      return Response.json({ id: "sess-1", directory, path: directory });',
        "    }",
        '    if (req.method === "POST" && url.pathname.endsWith("/message")) {',
        "      const body = await req.json();",
        '      record({ event: "message", body });',
        "      await new Promise((r) => setTimeout(r, 10_000));",
        '      record({ event: "message-resolved" });',
        '      return Response.json({ parts: [{ type: "text", text: "late result" }], error: null });',
        "    }",
        '    if (req.method === "GET" && url.pathname.endsWith("/message"))',
        '      return Response.json({ parts: [{ id: "p1", type: "text", text: "live" }], error: null });',
        '    if (req.method === "POST" && url.pathname.endsWith("/abort")) {',
        '      record({ event: "abort" });',
        "      return Response.json(true);",
        "    }",
        '    return Response.json({ error: { name: "NotFound" } }, { status: 404 });',
        "  },",
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    await startFakeLexa();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fakeLexa.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("spawns serve with the derived port, mints a session, writes the mapping pre-spawn, and aborts + drops the mapping on cancel", async () => {
    const daemon = spawnDaemon();
    let stderr = "";
    daemon.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    try {
      await waitFor(() => readServeEvents().find((e) => e.event === "spawn") ? true : undefined);
      const spawnEvent = readServeEvents().find((e) => e.event === "spawn");
      expect(spawnEvent?.args).toEqual(["serve", "--port", String(servePort), "--hostname", "127.0.0.1"]);

      const minted = await waitFor(() => {
        const e = readServeEvents().find((ev) => ev.event === "mint");
        return e ? e : undefined;
      });
      expect(minted.directory).toBe(join(dir, "projects", "p1"));

      const put = await waitFor(() => sessionsPuts[0]!);
      expect(put.body).toEqual({
        documentType: "task",
        documentId: "d1",
        runtimeId: "r-test",
        runtimeSessionId: "sess-1",
        provider: "opencode",
        agentId: "lexa",
        skillId: "hearth",
      });

      const msg = await waitFor(() => readServeEvents().find((e) => e.event === "message"));
      expect(msg.body?.model).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" });
      expect(msg.body?.agent).toBe("build");
      expect(msg.body?.parts).toEqual([{ type: "text", text: "write the docs" }]);

      await waitFor(() => readServeEvents().find((e) => e.event === "abort") ? true : undefined);
      const del = await waitFor(() => sessionsDeletes[0]!);
      expect(del.body).toEqual({ documentType: "task", documentId: "d1", runtimeId: "r-test" });

      expect(completes.length).toBe(0);
      expect(fails.length).toBe(0);
      expect(existsSync(join(dir, "runtimes", "r-test", "serve.pid"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        daemon.once("close", () => resolve());
        daemon.kill("SIGTERM");
        setTimeout(() => { daemon.kill("SIGKILL"); resolve(); }, 6_000).unref?.();
      });
    }
    expect(stderr).not.toContain("Fatal:");
  }, 40_000);
});
