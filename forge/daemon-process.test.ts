// forge/daemon.ts process-bound integration: the REAL daemon as a bun
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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
          skillId: "forge",
          skillName: "Forge",
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

describe("forge daemon (bun subprocess, fake server + fake agent)", () => {
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
      if (url === "/api/forge/runtimes/register") {
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
      if (url === "/api/forge/daemon/claim") {
        const haveTask = completes.length === 0;
        res.end(JSON.stringify(emptyClaim(haveTask ? "t1" : "")));
      } else if (url.startsWith("/api/forge/daemon/tasks/") && url.endsWith("/complete")) {
        completes.push({ url, body: JSON.parse(body) as Record<string, unknown> });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.startsWith("/api/forge/daemon/tasks/") && url.endsWith("/status")) {
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
        'echo "LXK_FORGE_DAEMON_TOKEN=${LXK_FORGE_DAEMON_TOKEN:-ABSENT}"',
        'echo "LEXA_URL=${LEXA_URL:-ABSENT}"',
        'echo "FORGE_POLL_MS=${FORGE_POLL_MS:-ABSENT}"',
        'echo "FORGE_CMD_BIN=${FORGE_CMD_BIN:-ABSENT}"',
        'echo "FORGE_AGENT=${FORGE_AGENT:-ABSENT}"',
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
    return spawn("bun", ["forge/daemon.ts"], {
      cwd: join(import.meta.dirname ?? ".", ".."),
      env: {
        ...process.env,
        LEXA_URL: base,
        LEXA_API_KEY: "lxk_daemon_key_1234567890123456789012345678901234567890",
        LXK_FORGE_DAEMON_TOKEN: "plain-shared-secret",
        FORGE_AGENT: "command-code",
        FORGE_CMD_BIN: agentScript,
        FORGE_MACHINE_ID: "m-test",
        FORGE_POLL_MS: "100",
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
      const complete = await waitFor(() => completes[0]);
      expect(complete.url).toContain("/api/forge/daemon/tasks/t1/complete");
      const result = String(complete.body.result ?? "");
      // Allowlisted vars reach the child...
      expect(result).toContain("PATH=present");
      expect(result).toContain(`HOME=${home}`);
      expect(result).toContain("PWD=");
      // ...but every Lexa credential and daemon config var is scrubbed.
      expect(result).toContain("LEXA_API_KEY=ABSENT");
      expect(result).toContain("LXK_FORGE_DAEMON_TOKEN=ABSENT");
      expect(result).toContain("LEXA_URL=ABSENT");
      expect(result).toContain("FORGE_POLL_MS=ABSENT");
      expect(result).toContain("FORGE_CMD_BIN=ABSENT");
      expect(result).toContain("FORGE_AGENT=ABSENT");
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
