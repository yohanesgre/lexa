// CliConfigService — ~/.lexa/config.json (login + deploy creds) and legacy
// dir migration. LEXA_DIR and HOME are read at module load (LEGACY_PATHS is
// bound from os.homedir() at import time), so every test redirects BOTH env
// vars to fresh tmp dirs before re-importing the module via dynamic import.
// Node's os.homedir() reads $HOME on every call (verified node 22: in-process
// changes are honored), so the beforeEach redirect binds LEGACY_PATHS to the
// tmp HOME and migrateLegacyDirsSync (called by every saveConfig/
// saveDeployCreds) never touches the real ~/.config/lexa-* dirs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Context } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliConfigService } from "./config";

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

describe("CliConfigService", () => {
  it("saveConfig writes config.json with trailing slashes trimmed and chmod 600", async () => {
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com:3000///", apiKey: "lxk_abc" }));
    const path = join(dir, "config.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "http://example.com:3000", apiKey: "lxk_abc" });
    expect(mode(path)).toBe(0o600);
  });

  it("loadConfig round-trips what saveConfig wrote", async () => {
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "lxk_abc" }));
    expect(await Effect.runPromise(svc.loadConfig())).toEqual({ url: "http://example.com", apiKey: "lxk_abc" });
  });

  it("loadConfig returns null when the file is missing", async () => {
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig())).toBeNull();
  });

  it("loadConfig returns null on corrupt JSON", async () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig())).toBeNull();
  });

  it("loadConfig returns null when url or apiKey is missing", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "http://example.com" }));
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig())).toBeNull();
  });

  it("loadConfig trims trailing slashes on read", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "http://example.com////", apiKey: "k" }));
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig())).toEqual({ url: "http://example.com", apiKey: "k" });
  });

  it("clearConfig removes the file and logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }));
    await Effect.runPromise(svc.clearConfig());
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Logged out. Removed"));
    log.mockRestore();
  });

  it("saveDeployCreds/loadDeployCreds round-trip and coexist with login keys", async () => {
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }));
    const creds = { cfToken: "cf-t", googleClientId: "g-id", googleClientSecret: "g-sec", cfTeamDomain: "lexa.cloudflareaccess.com", emailDomain: "example.com" };
    await Effect.runPromise(svc.saveDeployCreds(creds));
    expect(await Effect.runPromise(svc.loadDeployCreds())).toEqual(creds);
    // The login must survive the deploy-creds write.
    expect(await Effect.runPromise(svc.loadConfig())).toEqual({ url: "http://example.com", apiKey: "k" });
    expect(mode(join(dir, "config.json"))).toBe(0o600);
  });

  it("saveDeployCreds with partial creds stores only the provided keys", async () => {
    const svc = await loadService();
    await Effect.runPromise(svc.saveDeployCreds({ cfToken: "cf-t" }));
    expect(await Effect.runPromise(svc.loadDeployCreds())).toEqual({ cfToken: "cf-t" });
  });

  it("saveDeployCreds replaces a corrupt config.json", async () => {
    writeFileSync(join(dir, "config.json"), "{corrupt");
    const svc = await loadService();
    await Effect.runPromise(svc.saveDeployCreds({ emailDomain: "example.com" }));
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { deploy?: unknown };
    expect(raw.deploy).toEqual({ emailDomain: "example.com" });
  });

  it("lexaDir() reports the env override", async () => {
    const svc = await loadService();
    expect(svc.lexaDir()).toBe(dir);
  });

  it("saveConfig logs the path and chmod note", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Saved login to ${join(dir, "config.json")}`));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("chmod 600"));
    log.mockRestore();
  });

  it("saveConfig never touches the real ~/.config (migration is a tmp-dir no-op)", async () => {
    // Regression guard for the incident: with HOME redirected, the implicit
    // migrateLegacyDirsSync inside saveConfig must not create anything under
    // the tmp HOME (nothing migrated, nothing left behind).
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }));
    expect(existsSync(join(homeDir, ".config"))).toBe(false);
  });
});

describe("migrateLegacyDirs", () => {
  // Legacy pre-~/.lexa locations migrate-and-delete, no fallback: if the new
  // path exists it wins and the old one is removed. LEGACY_PATHS is bound
  // from os.homedir() at module load — the beforeEach HOME redirect +
  // dynamic import point it at the tmp home. The empty-parent cleanup is
  // best-effort (swallowed by catch) and only works under bun — node's
  // rmSync(dir, {force:true}) without recursive throws EISDIR — so the
  // assertions check the file-level migration, and the legacy dir may remain
  // but must be empty.
  it("moves legacy ~/.config/lexa-cli + lexa-forge state into LEXA_DIR", async () => {
    const legacyCli = join(homeDir, ".config", "lexa-cli");
    const legacyForge = join(homeDir, ".config", "lexa-forge");
    mkdirSync(legacyCli, { recursive: true });
    mkdirSync(legacyForge, { recursive: true });
    writeFileSync(join(legacyCli, "config.json"), JSON.stringify({ url: "http://legacy", apiKey: "k" }));
    writeFileSync(join(legacyCli, "machine-id"), "host-1\n");
    writeFileSync(join(legacyForge, "env"), "LEXA_URL=http://legacy\n");
    writeFileSync(join(legacyForge, "runtimes"), "{}");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());

    expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe(JSON.stringify({ url: "http://legacy", apiKey: "k" }));
    expect(readFileSync(join(dir, "machine-id"), "utf-8")).toBe("host-1\n");
    expect(readFileSync(join(dir, "env"), "utf-8")).toBe("LEXA_URL=http://legacy\n");
    expect(readFileSync(join(dir, "runtimes"), "utf-8")).toBe("{}");
    // Sources are gone (no fallback) — parents may linger empty under node.
    expect(existsSync(join(legacyCli, "config.json"))).toBe(false);
    expect(existsSync(join(legacyCli, "machine-id"))).toBe(false);
    expect(readdirSync(legacyCli).length).toBe(0);
    expect(existsSync(join(legacyForge, "env"))).toBe(false);
    expect(existsSync(join(legacyForge, "runtimes"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Migrated legacy"));
    log.mockRestore();
  });

  it("existing LEXA_DIR files win — legacy copies are deleted, not overwritten", async () => {
    const legacyCli = join(homeDir, ".config", "lexa-cli");
    mkdirSync(legacyCli, { recursive: true });
    writeFileSync(join(legacyCli, "config.json"), JSON.stringify({ url: "http://legacy", apiKey: "old" }));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ url: "http://new", apiKey: "new" }));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());

    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ url: "http://new", apiKey: "new" });
    expect(existsSync(join(legacyCli, "config.json"))).toBe(false);
    expect(readdirSync(legacyCli).length).toBe(0);
    log.mockRestore();
  });

  it("no-op when no legacy dirs exist (no log, nothing created)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Migrated legacy"));
    expect(readdirSync(homeDir).length).toBe(0);
    log.mockRestore();
  });
});
