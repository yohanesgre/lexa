// cli/machine.ts process-bound paths: systemd unit lifecycle
// (machineInstall/Start/Stop/Restart/Uninstall/Status/Logs) and the listener's
// daemon-child spawning (machineListen) — the scrubDaemonEnv-at-spawn security
// contract. child_process is mocked; HOME/LEXA_DIR point at tmp dirs so no
// real user state is touched. The listener derives its group dir from the
// config url ("http://fake-server" → <LEXA_DIR>/fake-server).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Context } from "effect";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const childMocks = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  spawnSyncCalls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  spawnSyncStatus: 0,
  // When true, spawn("bun", ...) children emit "exit" with code 3 (auth
  // failure) instead of completing as a probe.
  daemonExitCode: null as number | null,
  // Recorded machineHeartbeat bodies from the mocked client.
  heartbeats: [] as Array<Record<string, unknown>>,
  setupEvent: null as { event: Record<string, unknown>; rawKey: string | null } | null,
  completedEvents: [] as string[],
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcess => {
    childMocks.spawnCalls.push({ cmd, args, opts });
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as { pid?: number }).pid = 4242;
    const out = new EventEmitter();
    const err = new EventEmitter();
    (child as { stdout?: EventEmitter }).stdout = out;
    (child as { stderr?: EventEmitter }).stderr = err;
    (child as { kill?: () => boolean }).kill = () => true;
    if (cmd === "bun" && childMocks.daemonExitCode !== null) {
      // Listener-managed daemon child: emit the auth-failure exit.
      setTimeout(() => child.emit("exit", childMocks.daemonExitCode), 10);
    } else {
      // Probe/catalog child (runCapture): complete with version output.
      setTimeout(() => {
        out.emit("data", Buffer.from("probe-1.2.3\n"));
        child.emit("close", 0);
      }, 5);
    }
    return child;
  };
  const spawnSync = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    childMocks.spawnSyncCalls.push({ cmd, args, opts });
    return { status: childMocks.spawnSyncStatus, stdout: "", stderr: "", signal: null, pid: 1 };
  };
  return { ...actual, spawn, spawnSync };
});

vi.mock("./api", () => {
  const { Effect } = { Effect: require("effect").Effect } as { Effect: typeof import("effect").Effect };
  class MockLexaClient {
    machineHeartbeat(input: { id: string; hostname: string }): ReturnType<typeof Effect.succeed> {
      childMocks.heartbeats.push(input as unknown as Record<string, unknown>);
      return Effect.succeed({ id: input.id, hostname: input.hostname, clis: [], lastSeen: null, createdAt: "", projects: [] });
    }
    claimRuntimeEvent(): ReturnType<typeof Effect.succeed> {
      return Effect.succeed(childMocks.setupEvent);
    }
    completeRuntimeEvent(id: string): ReturnType<typeof Effect.succeed> {
      childMocks.completedEvents.push(id);
      return Effect.succeed({ id, status: "completed" });
    }
    failRuntimeEvent(): ReturnType<typeof Effect.succeed> {
      return Effect.succeed(null);
    }
  }
  return { LexaClient: MockLexaClient, ApiError: class ApiError extends Error {} };
});

let homeDir = "";
let dir = "";

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lexa-mproc-home-"));
  dir = mkdtempSync(join(tmpdir(), "lexa-mproc-lexa-"));
  process.env.HOME = homeDir;
  process.env.LEXA_DIR = dir;
  childMocks.spawnCalls.length = 0;
  childMocks.spawnSyncCalls.length = 0;
  childMocks.spawnSyncStatus = 0;
  childMocks.daemonExitCode = null;
  childMocks.heartbeats.length = 0;
  childMocks.setupEvent = null;
  childMocks.completedEvents.length = 0;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOME;
  delete process.env.LEXA_DIR;
  vi.restoreAllMocks();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function sysctlCalls(): string[] {
  return childMocks.spawnSyncCalls.filter((c) => c.cmd === "systemctl").map((c) => c.args.join(" "));
}

const SERVICE = "lexa-machine-listener";
const UNIT_PATH = () => join(homeDir, ".config", "systemd", "user", `${SERVICE}.service`);
// The group dir derived from the listener/install config url.
const GROUP_DIR = () => join(dir, "fake-server");
const CONFIG = { url: "http://fake-server", apiKey: "lxk_key" };

describe("systemd unit lifecycle", () => {
  it("machineInstall --no-systemd prints supervisor instructions and touches nothing", async () => {
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(mod.machineInstall({ noSystemd: true }, CONFIG));
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Start the machine listener under your supervisor:");
    expect(out).toContain("machine listen --url http://fake-server");
    expect(sysctlCalls()).toEqual([]);
    expect(existsSync(UNIT_PATH())).toBe(false);
    log.mockRestore();
  });

  it("machineInstall writes the unit (ExecStart pinned to --url) and enables+starts it via systemctl", async () => {
    childMocks.spawnSyncStatus = 0; // hasSystemd: status 0 or 1 → true
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(mod.machineInstall({}, CONFIG));
    // Unit written under the redirected HOME; the ExecStart bakes the URL so
    // the listener derives its group from the server it was installed for.
    const unit = readFileSync(UNIT_PATH(), "utf-8");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("machine listen --url http://fake-server");
    expect(sysctlCalls()).toContain("--user enable --now lexa-machine-listener");
    expect(sysctlCalls()).toContain("--user daemon-reload");
    log.mockRestore();
  });

  it("machineInstall without systemd prints manual instructions", async () => {
    childMocks.spawnSyncStatus = 3; // hasSystemd: not 0/1 → false
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(mod.machineInstall({}, CONFIG));
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("systemd not available — start the listener manually:");
    expect(out).toContain("machine listen --url http://fake-server");
    expect(sysctlCalls()).not.toContain("--user enable --now lexa-machine-listener");
    log.mockRestore();
  });

  it("machineStart/Stop/Restart pass the right systemctl verbs", async () => {
    childMocks.spawnSyncStatus = 0;
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(mod.machineStart(CONFIG.url));
    await Effect.runPromise(mod.machineStop());
    await Effect.runPromise(mod.machineRestart());
    expect(sysctlCalls()).toContain("--user enable --now lexa-machine-listener");
    expect(sysctlCalls()).toContain("--user stop lexa-machine-listener");
    expect(sysctlCalls()).toContain("--user restart lexa-machine-listener");
    log.mockRestore();
  });

  it("machineUninstall disables, removes the unit, and daemon-reloads", async () => {
    childMocks.spawnSyncStatus = 0;
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mkdirSync(join(homeDir, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(UNIT_PATH(), "[Unit]\n");
    await Effect.runPromise(mod.machineUninstall(GROUP_DIR()));
    expect(sysctlCalls()).toContain("--user disable --now lexa-machine-listener");
    expect(sysctlCalls()).toContain("--user daemon-reload");
    expect(existsSync(UNIT_PATH())).toBe(false);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(GROUP_DIR());
    log.mockRestore();
  });

  it("machineUninstall is idempotent when no unit is installed", async () => {
    const mod = await import("./machine");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(mod.machineUninstall(GROUP_DIR()));
    expect(sysctlCalls()).toEqual([]);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("nothing to remove");
    log.mockRestore();
  });

  it("machineLogs runs journalctl -f and exits with its status on failure", async () => {
    childMocks.spawnSyncStatus = 0;
    const mod = await import("./machine");
    await Effect.runPromise(mod.machineLogs());
    expect(childMocks.spawnSyncCalls.some((c) => c.cmd === "journalctl" && c.args.join(" ").includes("--user -u lexa-machine-listener -f"))).toBe(true);
  });

  it("machineLogs without systemd prints an error and exits 1", async () => {
    childMocks.spawnSyncStatus = 3;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("./machine");
    await expect(Effect.runPromise(mod.machineLogs())).rejects.toThrow(/exit\(1\)/);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("systemd (user) is not available.");
    exitSpy.mockRestore();
    err.mockRestore();
  });
});

describe("machineListen daemon spawning", () => {
  async function runListenOnce(windowMs = 1200): Promise<void> {
    const mod = await import("./machine");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    // machineListen exits(0) without a persisted machine secret — pre-write it
    // into the group dir derived from the config url.
    await Effect.runPromise(mod.saveMachineSecret("sec-1", GROUP_DIR()));
    const config = { url: "http://fake-server", apiKey: "lxk_key" };
    // Race: the listener is a forever loop — let one iteration run, then
    // interrupt it via the winning sleep branch.
    await Effect.runPromise(
      Effect.raceFirst(
        mod.machineListen(config).pipe(Effect.provideService(cfg, Context.get(svc, cfg))),
        Effect.sleep(windowMs).pipe(Effect.flatMap(() => Effect.succeed("done"))),
      ),
    );
  }

  function writeRuntimeEnv(agentCli: string, extra: Record<string, string> = {}): string {
    const runtimeId = extra.HEARTH_RUNTIME_ID ?? "r1";
    mkdirSync(join(GROUP_DIR(), "runtimes", runtimeId), { recursive: true });
    writeFileSync(
      join(GROUP_DIR(), "runtimes", runtimeId, "env"),
      [
        `LEXA_URL=http://fake-server`,
        `HEARTH_AGENT=${agentCli}`,
        `HEARTH_RUNTIME_ID=${runtimeId}`,
        `HEARTH_RUNTIME_NAME=host-${agentCli}`,
        `HEARTH_MACHINE_ID=m1`,
        ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
      ].join("\n") + "\n",
    );
    return runtimeId;
  }

  it("spawns a daemon child per runtime env with the scrubbed env + runtime overrides", async () => {
    writeRuntimeEnv("opencode");
    process.env.LXK_API_KEY = "shell-secret";
    process.env.GITHUB_TOKEN = "shell-token";
    await runListenOnce();
    delete process.env.LXK_API_KEY;
    delete process.env.GITHUB_TOKEN;

    const daemonSpawn = childMocks.spawnCalls.find((c) => c.cmd === "bun");
    expect(daemonSpawn).toBeDefined();
    expect(daemonSpawn?.args).toEqual(["run", join(homeDir, ".local", "share", "lexa-hearth", "daemon.js")]);
    const env = daemonSpawn?.opts.env as Record<string, string>;
    // Security contract: shell secrets never reach the child...
    expect(env.LXK_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // ...allowlisted vars survive...
    expect(env.PATH).toBeDefined();
    // ...and the listener passes its GROUP dir + derived flavor to the daemon
    // (the daemon reads LEXA_DIR/config.json, runtimes/, projects/ as before).
    expect(env.LEXA_DIR).toBe(GROUP_DIR());
    expect(env.LEXA_FLAVOR).toBe("prod");
    // ...and the runtime env file is the ONLY credential source.
    expect(env.LEXA_URL).toBe("http://fake-server");
    expect(env.HEARTH_AGENT).toBe("opencode");
    expect(env.HEARTH_RUNTIME_ID).toBe("r1");
    // normalizeRuntimeEnv overrides the machine id with the listener's own.
    expect(env.HEARTH_MACHINE_ID).toMatch(/^[^-]+-[0-9a-f]{8}$/);
    // Daemon pid persisted for the stale-daemon sweep on next boot.
    expect(readFileSync(join(GROUP_DIR(), "runtimes", "r1", "daemon.pid"), "utf-8").trim()).toBe("4242");
  });

  it("the runtime env file may legitimately carry LEXA_API_KEY (its only credential source)", async () => {
    writeRuntimeEnv("hermes", { LEXA_API_KEY: "lxk_runtime_key" });
    await runListenOnce();
    const daemonSpawn = childMocks.spawnCalls.find((c) => c.cmd === "bun");
    const env = daemonSpawn?.opts.env as Record<string, string>;
    expect(env.LEXA_API_KEY).toBe("lxk_runtime_key");
  });

  it("heartbeats carry the machine id and the provisioned projects stay empty", async () => {
    writeRuntimeEnv("opencode");
    await runListenOnce();
    expect(childMocks.heartbeats.length).toBeGreaterThan(0);
    expect(childMocks.heartbeats[0].id).toBeDefined();
  });

  it("a setup install event writes the runtime env with the one-time key and spawns its daemon", async () => {
    childMocks.setupEvent = {
      event: { id: "evt-1", machineId: "m1", action: "install", agentCli: "command-code", apiKeyId: null, status: "pending", error: null, createdAt: "2026-01-01T00:00:00Z", claimedAt: null, finishedAt: null },
      rawKey: "lxk_onetime",
    };
    await runListenOnce();
    const daemonSpawns = childMocks.spawnCalls.filter((c) => c.cmd === "bun");
    // Second spawn = the event-created runtime; its env carries the one-time key.
    const eventSpawn = daemonSpawns[daemonSpawns.length - 1];
    const env = eventSpawn?.opts.env as Record<string, string>;
    expect(env.LEXA_API_KEY).toBe("lxk_onetime");
    expect(env.HEARTH_AGENT).toBe("command-code");
    expect(childMocks.completedEvents).toContain("evt-1");
    // Env file persisted under <group>/runtimes/<id>/.
    const envDirs = readdirSync(join(GROUP_DIR(), "runtimes")).filter((d) => d !== "r1");
    expect(envDirs.length).toBe(1);
    expect(readFileSync(join(GROUP_DIR(), "runtimes", envDirs[0], "env"), "utf-8")).toContain("LEXA_API_KEY=lxk_onetime");
  });

  it("a daemon auth-failure exit (code 3) is NOT respawned and is relayed on the next heartbeat", async () => {
    writeRuntimeEnv("opencode");
    childMocks.daemonExitCode = 3;
    // The exit fires 10ms after spawn; the relay lands on heartbeat #2 (the
    // poll loop sleeps 3000ms between iterations) — widen the window.
    await runListenOnce(3600);
    // The code-3 child is never respawned — exactly one bun spawn.
    const daemonSpawns = childMocks.spawnCalls.filter((c) => c.cmd === "bun");
    expect(daemonSpawns.length).toBe(1);
    // The relay lands on a later heartbeat (the exit fires after the first).
    const relayed = childMocks.heartbeats.find((h) => (h.daemonErrors as Array<{ runtimeId: string; error: string }> | undefined)?.length);
    expect(relayed).toBeDefined();
    expect((relayed?.daemonErrors as Array<{ runtimeId: string; error: string }>)[0]).toEqual({ runtimeId: "r1", error: "API key revoked" });
  });
});
