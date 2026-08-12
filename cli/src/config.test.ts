// CliConfigService — group-keyed ~/.lexa/<host>/config.json (login + deploy
// creds) and the legacy migrations. LEXA_DIR and HOME are read at module load
// (LEGACY_PATHS is bound from os.homedir() at import time), so every test
// redirects BOTH env vars to fresh tmp dirs before re-importing the module
// via dynamic import. Node's os.homedir() reads $HOME on every call (verified
// node 22: in-process changes are honored), so the beforeEach redirect binds
// the legacy dirs to the tmp HOME and the migrations never touch the real
// ~/.config/lexa-* or ~/.lexa-* dirs.
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

// The group dir a saved login for this url would live in (module LEXA_DIR is
// bound to the tmp `dir` from the beforeEach redirect).
async function groupFor(url: string): Promise<string> {
  const { groupDir } = await import("./config");
  return groupDir(url);
}

describe("normalizeHost", () => {
  it("strips schemes and lowercases", async () => {
    const { normalizeHost } = await import("./config");
    expect(normalizeHost("https://Lexa.Example.Com")).toBe("lexa.example.com");
    expect(normalizeHost("http://lexa.yohanesgre.com")).toBe("lexa.yohanesgre.com");
  });

  it("accepts bare hosts", async () => {
    const { normalizeHost } = await import("./config");
    expect(normalizeHost("lexa.yohanesgre.com")).toBe("lexa.yohanesgre.com");
    expect(normalizeHost("10.0.0.5")).toBe("10.0.0.5");
    expect(normalizeHost("192.168.1.50")).toBe("192.168.1.50");
  });

  it("strips default ports (80/443) and keeps explicit ones", async () => {
    const { normalizeHost } = await import("./config");
    expect(normalizeHost("http://example.com:80")).toBe("example.com");
    expect(normalizeHost("https://example.com:443")).toBe("example.com");
    expect(normalizeHost("http://example.com:8443")).toBe("example.com:8443");
    expect(normalizeHost("localhost:3000")).toBe("localhost:3000");
    expect(normalizeHost("localhost:8794")).toBe("localhost:8794");
  });

  it("maps loopback hosts to localhost (explicit ports survive)", async () => {
    const { normalizeHost } = await import("./config");
    expect(normalizeHost("http://localhost")).toBe("localhost");
    expect(normalizeHost("http://localhost:3000")).toBe("localhost:3000");
    expect(normalizeHost("http://127.0.0.1")).toBe("localhost");
    expect(normalizeHost("127.0.0.1")).toBe("localhost");
    expect(normalizeHost("http://127.0.0.1:3000")).toBe("localhost:3000");
    expect(normalizeHost("127.0.0.5:8443")).toBe("localhost:8443");
    expect(normalizeHost("http://[::1]")).toBe("localhost");
    expect(normalizeHost("http://[::1]:3000")).toBe("localhost:3000");
    expect(normalizeHost("[::1]")).toBe("localhost");
  });

  it("strips IPv6 brackets but keeps colons", async () => {
    const { normalizeHost } = await import("./config");
    expect(normalizeHost("http://[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeHost("2001:db8::1")).toBe("2001:db8::1");
  });
});

describe("groupDir + flavorFor", () => {
  it("groupDir nests the normalized host under the state root", async () => {
    const { groupDir } = await import("./config");
    expect(groupDir("https://lexa.yohanesgre.com")).toBe(join(dir, "lexa.yohanesgre.com"));
    expect(groupDir("http://localhost:3000")).toBe(join(dir, "localhost:3000"));
    expect(groupDir("https://192.168.1.50:8443")).toBe(join(dir, "192.168.1.50:8443"));
    expect(groupDir("127.0.0.1")).toBe(join(dir, "localhost"));
  });

  it("flavorFor: loopback → dev, everything else prod", async () => {
    const { flavorFor } = await import("./config");
    expect(flavorFor("http://localhost:3000")).toBe("dev");
    expect(flavorFor("http://127.0.0.1")).toBe("dev");
    expect(flavorFor("http://[::1]")).toBe("dev");
    expect(flavorFor("https://lexa.yohanesgre.com")).toBe("prod");
  });

  it("flavorFor: LEXA_FLAVOR env overrides (staging server on a non-loopback host)", async () => {
    const { flavorFor } = await import("./config");
    process.env.LEXA_FLAVOR = "staging";
    try {
      expect(flavorFor("https://lexa-preview.yohanesgre.com")).toBe("staging");
      expect(flavorFor("http://localhost:3000")).toBe("staging");
    } finally {
      delete process.env.LEXA_FLAVOR;
    }
    expect(flavorFor("https://lexa-preview.yohanesgre.com")).toBe("prod");
  });

  it("flavorFor: invalid LEXA_FLAVOR is ignored", async () => {
    const { flavorFor } = await import("./config");
    process.env.LEXA_FLAVOR = "bogus";
    try {
      expect(flavorFor("http://localhost")).toBe("dev");
    } finally {
      delete process.env.LEXA_FLAVOR;
    }
  });
});

describe("CliConfigService", () => {
  it("saveConfig writes config.json into the group dir with chmod 600", async () => {
    const svc = await loadService();
    const g = await groupFor("http://example.com:3000");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com:3000///", apiKey: "lxk_abc" }, g));
    const path = join(g, "config.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "http://example.com:3000", apiKey: "lxk_abc" });
    expect(mode(path)).toBe(0o600);
  });
  it("loadConfig round-trips what saveConfig wrote", async () => {
    const svc = await loadService();
    const g = await groupFor("http://example.com");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "lxk_abc" }, g));
    expect(await Effect.runPromise(svc.loadConfig(g))).toEqual({ url: "http://example.com", apiKey: "lxk_abc" });
  });
  it("loadConfig returns null when the file is missing", async () => {
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig(await groupFor("http://example.com")))).toBeNull();
  });
  it("loadConfig returns null on corrupt JSON", async () => {
    const g = await groupFor("http://example.com");
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, "config.json"), "{not json");
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig(g))).toBeNull();
  });
  it("loadConfig returns null when url or apiKey is missing", async () => {
    const g = await groupFor("http://example.com");
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, "config.json"), JSON.stringify({ url: "http://example.com" }));
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig(g))).toBeNull();
  });
  it("loadConfig trims trailing slashes on read", async () => {
    const g = await groupFor("http://example.com");
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, "config.json"), JSON.stringify({ url: "http://example.com////", apiKey: "k" }));
    const svc = await loadService();
    expect(await Effect.runPromise(svc.loadConfig(g))).toEqual({ url: "http://example.com", apiKey: "k" });
  });
  it("clearConfig removes the file and logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadService();
    const g = await groupFor("http://example.com");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }, g));
    await Effect.runPromise(svc.clearConfig(g));
    expect(existsSync(join(g, "config.json"))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Logged out. Removed"));
    log.mockRestore();
  });
  it("saveDeployCreds/loadDeployCreds round-trip and coexist with login keys", async () => {
    const svc = await loadService();
    const g = await groupFor("http://example.com");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }, g));
    const creds = { cfToken: "cf-t" };
    await Effect.runPromise(svc.saveDeployCreds(creds, g));
    expect(await Effect.runPromise(svc.loadDeployCreds(g))).toEqual(creds);
    // The login must survive the deploy-creds write.
    expect(await Effect.runPromise(svc.loadConfig(g))).toEqual({ url: "http://example.com", apiKey: "k" });
    expect(mode(join(g, "config.json"))).toBe(0o600);
  });
  it("saveDeployCreds with partial creds stores only the provided keys", async () => {
    const svc = await loadService();
    const g = await groupFor("http://example.com");
    await Effect.runPromise(svc.saveDeployCreds({ cfToken: "cf-t" }, g));
    expect(await Effect.runPromise(svc.loadDeployCreds(g))).toEqual({ cfToken: "cf-t" });
  });
  it("saveDeployCreds replaces a corrupt config.json", async () => {
    const g = await groupFor("http://example.com");
    mkdirSync(g, { recursive: true });
    writeFileSync(join(g, "config.json"), "{corrupt");
    const svc = await loadService();
    await Effect.runPromise(svc.saveDeployCreds({ cfToken: "cf-t" }, g));
    const raw = JSON.parse(readFileSync(join(g, "config.json"), "utf-8")) as { deploy?: unknown };
    expect(raw.deploy).toEqual({ cfToken: "cf-t" });
  });
  it("savedLogin finds the login in a group dir", async () => {
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://lexa.example.com", apiKey: "k" }, await groupFor("http://lexa.example.com")));
    expect(await Effect.runPromise(svc.savedLogin())).toEqual({ url: "http://lexa.example.com", apiKey: "k" });
  });
  it("savedLogin is null when no group has a login", async () => {
    const svc = await loadService();
    expect(await Effect.runPromise(svc.savedLogin())).toBeNull();
  });
  it("lexaDir() reports the env override", async () => {
    const svc = await loadService();
    expect(svc.lexaDir()).toBe(dir);
  });
  it("saveConfig logs the path and chmod note", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadService();
    const g = await groupFor("http://example.com");
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }, g));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Saved login to ${join(g, "config.json")}`));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("chmod 600"));
    log.mockRestore();
  });
  it("saveConfig never touches the real ~/.config (migration is a tmp-dir no-op)", async () => {
    // Regression guard for the incident: with HOME redirected, the implicit
    // migrateLegacyDirsSync inside saveConfig must not create anything under
    // the tmp HOME (nothing migrated, nothing left behind).
    const svc = await loadService();
    await Effect.runPromise(svc.saveConfig({ url: "http://example.com", apiKey: "k" }, await groupFor("http://example.com")));
    expect(existsSync(join(homeDir, ".config"))).toBe(false);
  });
});

describe("migrateLegacyDirs (retargeted to groups)", () => {
  // Legacy pre-group ~/.config/lexa-cli|lexa-forge files move into the group
  // named by the legacy config.json url; if the group file exists it wins and
  // the old one is removed. No legacy config.json → skip silently.
  it("moves legacy ~/.config/lexa-cli + lexa-forge state into the config-url group", async () => {
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
  });

  it("existing group files win — legacy copies are deleted, not overwritten", async () => {
    const legacyCli = join(homeDir, ".config", "lexa-cli");
    mkdirSync(legacyCli, { recursive: true });
    writeFileSync(join(legacyCli, "config.json"), JSON.stringify({ url: "http://legacy.example.com", apiKey: "old" }));
    mkdirSync(join(dir, "legacy.example.com"), { recursive: true });
    writeFileSync(join(dir, "legacy.example.com", "config.json"), JSON.stringify({ url: "http://new", apiKey: "new" }));

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());

    expect(JSON.parse(readFileSync(join(dir, "legacy.example.com", "config.json"), "utf-8"))).toEqual({ url: "http://new", apiKey: "new" });
    expect(existsSync(join(legacyCli, "config.json"))).toBe(false);
    expect(readdirSync(legacyCli).length).toBe(0);
    log.mockRestore();
  });

  it("skips silently when no legacy config.json exists", async () => {
    const legacyCli = join(homeDir, ".config", "lexa-cli");
    mkdirSync(legacyCli, { recursive: true });
    writeFileSync(join(legacyCli, "machine-id"), "host-1\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    const svc = await loadService();
    await Effect.runPromise(svc.migrateLegacyDirs());
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Migrated legacy"));
    expect(readdirSync(legacyCli)).toEqual(["machine-id"]);
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

describe("migrateFlavorRoots (legacy flavor roots → groups)", () => {
  // Runs only when LEXA_DIR is UNSET — the module then binds LEXA_DIR to
  // ~/.lexa under the redirected tmp HOME.
  async function loadServiceWithoutLexaDir(): Promise<CliConfigService> {
    delete process.env.LEXA_DIR;
    vi.resetModules();
    return loadService();
  }

  const root = () => join(homeDir, ".lexa");

  it("moves ~/.lexa-dev into the group of its config.json url and removes the root", async () => {
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
  });

  it("moves ~/.lexa-staging into its host group", async () => {
    const staging = join(homeDir, ".lexa-staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "config.json"), JSON.stringify({ url: "https://lexa-preview.example.com", apiKey: "k" }));
    writeFileSync(join(staging, "machine-id"), "host-stage\n");
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(existsSync(join(root(), "lexa-preview.example.com", "machine-id"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  it("old-layout ~/.lexa top-level state moves into its host group (root stays as the group parent)", async () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), "config.json"), JSON.stringify({ url: "https://lexa.example.com", apiKey: "k" }));
    writeFileSync(join(root(), "machine-id"), "host-prod\n");
    mkdirSync(join(root(), "runtimes", "r1"), { recursive: true });
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(readFileSync(join(root(), "lexa.example.com", "config.json"), "utf-8")).toBe(JSON.stringify({ url: "https://lexa.example.com", apiKey: "k" }));
    expect(existsSync(join(root(), "lexa.example.com", "runtimes", "r1"))).toBe(true);
    // The root itself stays (it is the group parent), but holds no top-level state.
    expect(readdirSync(root())).toEqual(["lexa.example.com"]);
  });

  it("new-layout ~/.lexa (only <host>/ subdirs) is untouched", async () => {
    mkdirSync(join(root(), "lexa.example.com"), { recursive: true });
    writeFileSync(join(root(), "lexa.example.com", "config.json"), JSON.stringify({ url: "https://lexa.example.com", apiKey: "k" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(readdirSync(root())).toEqual(["lexa.example.com"]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Migration: moved"));
    log.mockRestore();
  });

  it("a flavor root without a config.json url is skipped with a warning", async () => {
    const dev = join(homeDir, ".lexa-dev");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "machine-id"), "host-dev\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(existsSync(join(dev, "machine-id"))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped"));
    log.mockRestore();
  });

  it("re-running is a no-op (idempotent — existing group wins)", async () => {
    const staging = join(homeDir, ".lexa-staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "config.json"), JSON.stringify({ url: "https://lexa-preview.example.com", apiKey: "k" }));
    writeFileSync(join(staging, "machine-id"), "host-stage\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = await loadServiceWithoutLexaDir();
    await Effect.runPromise(svc.migrateFlavorRoots());
    log.mockReset();
    await Effect.runPromise(svc.migrateFlavorRoots());

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Migration: moved"));
    expect(existsSync(join(root(), "lexa-preview.example.com", "machine-id"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    log.mockRestore();
  });

  it("does nothing when LEXA_DIR is set (test/operator root override)", async () => {
    const dev = join(homeDir, ".lexa-dev");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "config.json"), JSON.stringify({ url: "http://localhost:3000", apiKey: "k" }));
    // LEXA_DIR is still set by the outer beforeEach.
    const svc = await loadService();
    await Effect.runPromise(svc.migrateFlavorRoots());
    expect(existsSync(join(dev, "config.json"))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
