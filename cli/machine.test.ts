// cli/machine.ts — pure fs parts: scrubDaemonEnv (closed allowlist + secret
// blocklist), machine-id/machine-secret persistence, and the workspace
// listing. All paths derive from LEXA_DIR at module load, so tests re-import
// the module against a fresh tmp dir. Process-bound pieces (machineListen,
// probeClis, systemd install, daemon spawn) are skipped — they spawn real
// children.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-machine-test-"));
  process.env.LEXA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.LEXA_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("scrubDaemonEnv", () => {
  // Closed allowlist: exact keys + LC_/XDG_/BUN_ prefixes, then a secret
  // blocklist (LXK_/GITHUB_/CF_/CLOUDFLARE_/AWS_/AZURE_/GOOGLE_ prefixes +
  // SECRET/TOKEN/PRIVATE_KEY/API_KEY/PASSWORD markers). Blocklist wins.
  it("keeps allowlisted vars", async () => {
    const mod = await import("./machine");
    const env = { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", TERM: "xterm", TZ: "UTC", PWD: "/w", SHELL: "/bin/zsh", USER: "u", LOGNAME: "u" };
    expect(mod.scrubDaemonEnv(env)).toEqual(env);
  });

  it("keeps allowlisted prefixes (LC_/XDG_/BUN_)", async () => {
    const mod = await import("./machine");
    const env = { LC_ALL: "C", XDG_CONFIG_HOME: "/x/c", BUN_INSTALL: "/bun" };
    expect(mod.scrubDaemonEnv(env)).toEqual(env);
  });

  it("drops unknown non-secret vars (closed allowlist)", async () => {
    const mod = await import("./machine");
    expect(mod.scrubDaemonEnv({ FOO: "bar", EDITOR: "vim", PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  it("drops secret-prefixed vars (LXK_/GITHUB_/CF_/CLOUDFLARE_/AWS_/AZURE_/GOOGLE_)", async () => {
    const mod = await import("./machine");
    const env = {
      LXK_API_KEY: "lxk_x",
      LXK_FORGE_DAEMON_TOKEN: "deadbeef",
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "-----BEGIN",
      CF_API_TOKEN: "cf-t",
      CLOUDFLARE_API_TOKEN: "cf-t2",
      AWS_SECRET_ACCESS_KEY: "aws",
      AZURE_CLIENT_SECRET: "az",
      GOOGLE_CLIENT_ID: "g-id",
      PATH: "/usr/bin",
    };
    expect(mod.scrubDaemonEnv(env)).toEqual({ PATH: "/usr/bin" });
  });

  it("drops vars with SECRET/TOKEN/PRIVATE_KEY/API_KEY/PASSWORD markers (case-insensitive)", async () => {
    const mod = await import("./machine");
    const env = { LEXA_API_KEY: "lxk_x", FORGE_DAEMON_TOKEN: "tok", MY_PRIVATE_KEY: "k", DB_PASSWORD: "pw", api_token: "t", PATH: "/usr/bin" };
    expect(mod.scrubDaemonEnv(env)).toEqual({ PATH: "/usr/bin" });
  });

  it("handles undefined values (key dropped) and empty input", async () => {
    const mod = await import("./machine");
    expect(mod.scrubDaemonEnv({ PATH: undefined })).toEqual({});
    expect(mod.scrubDaemonEnv({})).toEqual({});
  });
});

describe("getOrCreateMachineId", () => {
  it("creates <hostname>-<hex8> in LEXA_DIR with chmod 600", async () => {
    const mod = await import("./machine");
    const id = await Effect.runPromise(mod.getOrCreateMachineId());
    expect(id).toMatch(/^[^-]+-[0-9a-f]{8}$/);
    expect(readFileSync(join(dir, "machine-id"), "utf-8").trim()).toBe(id);
    expect(mode(join(dir, "machine-id"))).toBe(0o600);
  });

  it("is stable across calls — never regenerates once written", async () => {
    const mod = await import("./machine");
    const first = await Effect.runPromise(mod.getOrCreateMachineId());
    const second = await Effect.runPromise(mod.getOrCreateMachineId());
    expect(second).toBe(first);
  });

  it("reuses an existing machine-id file", async () => {
    writeFileSync(join(dir, "machine-id"), "host-abc123\n");
    const mod = await import("./machine");
    expect(await Effect.runPromise(mod.getOrCreateMachineId())).toBe("host-abc123");
  });

  it("does not crash on unwritable dir — falls back to a fresh id", async () => {
    // NOTE: an unwritable LEXA_DIR via /proc hangs node's recursive
    // mkdirSync (kernel quirk, verified) — use a chmod-000 dir instead.
    const locked = mkdtempSync(join(tmpdir(), "lexa-machine-locked-"));
    chmodSync(locked, 0o000);
    process.env.LEXA_DIR = locked;
    vi.resetModules();
    const mod = await import("./machine");
    const id = await Effect.runPromise(mod.getOrCreateMachineId());
    chmodSync(locked, 0o700);
    rmSync(locked, { recursive: true, force: true });
    expect(id).toMatch(/^[^-]+-[0-9a-f]{8}$/);
  });
});

describe("machine secret", () => {
  it("getOrCreateMachineSecret returns '' when absent", async () => {
    const mod = await import("./machine");
    expect(await Effect.runPromise(mod.getOrCreateMachineSecret())).toBe("");
  });

  it("saveMachineSecret persists chmod 600 and is read back", async () => {
    const mod = await import("./machine");
    await Effect.runPromise(mod.saveMachineSecret("sec-1"));
    const path = join(dir, "machine-secret");
    expect(readFileSync(path, "utf-8")).toBe("sec-1\n");
    expect(mode(path)).toBe(0o600);
    expect(await Effect.runPromise(mod.getOrCreateMachineSecret())).toBe("sec-1");
  });

  it("saveMachineSecret overwrites the previous secret", async () => {
    const mod = await import("./machine");
    await Effect.runPromise(mod.saveMachineSecret("sec-1"));
    await Effect.runPromise(mod.saveMachineSecret("sec-2"));
    expect(await Effect.runPromise(mod.getOrCreateMachineSecret())).toBe("sec-2");
  });
});

describe("workspaceList", () => {
  it("prints the empty hint when no workspace dirs exist", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./machine");
    await Effect.runPromise(mod.workspaceList());
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("No workspaces yet");
    log.mockRestore();
  });

  it("lists provisioned, empty, and orphan workspaces from the project index", async () => {
    mkdirSync(join(dir, "projects", "p1"), { recursive: true });
    writeFileSync(join(dir, "projects", "p1", "README.md"), "# P1");
    mkdirSync(join(dir, "projects", "p2"), { recursive: true }); // empty
    mkdirSync(join(dir, "projects", "p3"), { recursive: true }); // not in index → orphan
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ p1: { name: "One", slug: "one", description: "" }, p2: { name: "Two", slug: "two", description: "" } }));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./machine");
    await Effect.runPromise(mod.workspaceList());
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("One");
    expect(lines).toContain("provisioned");
    expect(lines).toContain("Two");
    expect(lines).toContain("empty");
    expect(lines).toContain("p3");
    expect(lines).toContain("orphan");
    log.mockRestore();
  });

  it("survives a corrupt project index (degrades to orphan rows)", async () => {
    mkdirSync(join(dir, "projects", "p1"), { recursive: true });
    writeFileSync(join(dir, "projects.json"), "{corrupt");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./machine");
    await Effect.runPromise(mod.workspaceList());
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("orphan");
    log.mockRestore();
  });
});
