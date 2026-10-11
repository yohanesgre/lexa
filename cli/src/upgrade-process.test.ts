// cli/upgrade.ts process-bound path: the self-update download (curl spawn,
// size guard, chmod + rename). COMPILED is mocked true; the GitHub releases
// API is stubbed via fetch; curl is mocked via child_process; process.execPath
// is redirected at a tmp file so the rename never touches the real binary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTagToVersion, lxInstallPath } from "./upgrade";

const childMocks = vi.hoisted(() => ({
  curlCalls: [] as Array<{ cmd: string; args: string[] }>,
  curlStatus: 0,
  curlStatuses: [] as number[],
}));

vi.mock("./config", () => ({ COMPILED: true }));
vi.mock("./version", () => ({ CLI_VERSION: "1.2.3" }));

vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  return {
    spawnSync: (cmd: string, args: string[]) => {
      childMocks.curlCalls.push({ cmd, args });
      // Simulate a real download: curl -o <path> writes the file.
      const o = args.indexOf("-o");
      if (o > 0 && args[o + 1] !== undefined) fs.writeFileSync(args[o + 1]!, "downloaded-binary");
      const status = childMocks.curlStatuses.shift() ?? childMocks.curlStatus;
      return { status, stdout: "", stderr: "", signal: null, pid: 1 };
    },
  };
});

function stubReleases(tags: string[]): void {
  vi.stubGlobal(
    "fetch",
    () => Promise.resolve(new Response(JSON.stringify(tags.map((tag_name) => ({ tag_name }))), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
}

function stubBunFile(size: number): void {
  vi.stubGlobal("Bun", { file: () => ({ stat: async () => ({ size }) }) });
}

const CLI_ASSETS = [
  "https://github.com/yohanesgre/lexa/releases/download/cli-v2.0.0/lx",
  "https://github.com/yohanesgre/lexa/releases/download/cli-v2.0.0/lexa-cli",
];

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-upgrade-"));
  childMocks.curlCalls.length = 0;
  childMocks.curlStatus = 0;
  childMocks.curlStatuses.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function mockExecPath(path: string): () => void {
  const desc = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", { value: path, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process, "execPath", desc);
  };
}

describe("cmdUpgradeCli (COMPILED=true)", () => {
  it("reports already up to date when the newest cli-v tag matches the installed version", async () => {
    stubReleases(["cli-v1.2.3", "cli-v0.9.0"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./upgrade");
    await Effect.runPromise(mod.cmdUpgradeCli());
    const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
    expect(out).toContain("Already up to date (latest: cli-v1.2.3).");
    expect(childMocks.curlCalls).toEqual([]);
    log.mockRestore();
  });

  it("downloads the newer release with curl -fsSL -o <self>.new, then chmod 755 + renames", async () => {
    stubReleases(["cli-v2.0.0"]);
    stubBunFile(2 * 1024 * 1024);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreExecPath = mockExecPath(join(dir, "lx"));
    writeFileSync(join(dir, "lx"), "old-binary");
    const mod = await import("./upgrade");
    await Effect.runPromise(mod.cmdUpgradeCli());

    expect(childMocks.curlCalls.length).toBe(1);
    expect(childMocks.curlCalls[0]!.cmd).toBe("curl");
    expect(childMocks.curlCalls[0]!.args).toEqual(["-fsSL", "-o", join(dir, "lx.new"), CLI_ASSETS[0]]);
    // chmod 755 + rename: the .new file is gone, the binary is in place.
    expect(existsSync(join(dir, "lx.new"))).toBe(false);
    expect(existsSync(join(dir, "lx"))).toBe(true);
    expect(statSync(join(dir, "lx")).mode & 0o777).toBe(0o755);
    const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
    expect(out).toContain("1.2.3 → cli-v2.0.0");
    log.mockRestore();
    restoreExecPath();
  });

  it("installs as lx and removes the legacy name when run from lexa-cli", async () => {
    stubReleases(["cli-v2.0.0"]);
    stubBunFile(2 * 1024 * 1024);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreExecPath = mockExecPath(join(dir, "lexa-cli"));
    writeFileSync(join(dir, "lexa-cli"), "old-binary");
    const mod = await import("./upgrade");
    await Effect.runPromise(mod.cmdUpgradeCli());

    expect(childMocks.curlCalls[0]!.args).toEqual(["-fsSL", "-o", join(dir, "lx.new"), CLI_ASSETS[0]]);
    expect(existsSync(join(dir, "lx"))).toBe(true);
    expect(existsSync(join(dir, "lexa-cli"))).toBe(false);
    expect(statSync(join(dir, "lx")).mode & 0o777).toBe(0o755);
    const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
    expect(out).toContain("Renamed `lexa-cli` → `lx`");
    log.mockRestore();
    restoreExecPath();
  });

  it("falls back to the legacy asset when the lx download fails, and fails when both do", async () => {
    stubReleases(["cli-v2.0.0"]);
    stubBunFile(2 * 1024 * 1024);
    childMocks.curlStatuses.push(22, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreExecPath = mockExecPath(join(dir, "lx"));
    writeFileSync(join(dir, "lx"), "old-binary");
    const mod = await import("./upgrade");
    await Effect.runPromise(mod.cmdUpgradeCli());
    expect(childMocks.curlCalls.map((c) => c.args[3])).toEqual(CLI_ASSETS);
    // The legacy download is chmod 755 + renamed into place.
    expect(existsSync(join(dir, "lx"))).toBe(true);
    expect(statSync(join(dir, "lx")).mode & 0o777).toBe(0o755);
    log.mockRestore();

    childMocks.curlCalls.length = 0;
    childMocks.curlStatuses.length = 0;
    childMocks.curlStatus = 22;
    writeFileSync(join(dir, "lx"), "old-binary");
    const err = (await Effect.runPromise(mod.cmdUpgradeCli()).catch((e) => e)) as Error;
    expect(err.message).toBe("download failed (curl status 22)");
    expect(childMocks.curlCalls.map((c) => c.args[3])).toEqual(CLI_ASSETS);
    restoreExecPath();
  });

  it("aborts when the downloaded file is smaller than 1MB", async () => {
    stubReleases(["cli-v2.0.0"]);
    stubBunFile(500 * 1024);
    const restoreExecPath = mockExecPath(join(dir, "lx"));
    writeFileSync(join(dir, "lx"), "old");
    const mod = await import("./upgrade");
    const err = (await Effect.runPromise(mod.cmdUpgradeCli()).catch((e) => e)) as Error;
    expect(err.message).toMatch(/downloaded file looks wrong \(512000 bytes\) — aborting/);
    // The broken download is not renamed into place — self keeps its content.
    expect(existsSync(join(dir, "lx"))).toBe(true);
    restoreExecPath();
  });
});

// Carried from cli/src/upgrade.test.ts (K5/K7 — the cli-vs-web tag guard and
// the lexa-cli→lx rename transition that cmdUpgradeCli depends on).
describe("cli tag + install path guards", () => {
  it("cliTagToVersion parses cli-vX.Y.Z / dotted numeric and rejects web tags + malformed", () => {
    expect(cliTagToVersion("cli-v1.2.3")).toBe("1.2.3");
    expect(cliTagToVersion("cli-v0.1.0")).toBe("0.1.0");
    expect(cliTagToVersion("cli-v1.2")).toBe("1.2");
    expect(cliTagToVersion("cli-v1.2.3.4")).toBe("1.2.3.4");
    expect(cliTagToVersion("v1.2.3")).toBeNull();
    expect(cliTagToVersion("cli-v")).toBeNull();
    expect(cliTagToVersion("releases/latest")).toBeNull();
    expect(cliTagToVersion("cli-v1.2.")).toBeNull();
    expect(cliTagToVersion("cli-vx")).toBeNull();
    expect(cliTagToVersion("cli-v1..2")).toBeNull();
  });

  it("lxInstallPath keeps an existing lx path and migrates legacy names to the sibling lx", () => {
    expect(lxInstallPath("/home/u/.local/bin/lx")).toBe("/home/u/.local/bin/lx");
    expect(lxInstallPath("/usr/local/bin/lx")).toBe("/usr/local/bin/lx");
    expect(lxInstallPath("/home/u/.local/bin/lexa-cli")).toBe("/home/u/.local/bin/lx");
    expect(lxInstallPath("/usr/local/bin/lexa-cli")).toBe("/usr/local/bin/lx");
  });
});
