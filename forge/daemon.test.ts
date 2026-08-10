// forge/daemon.ts — the agent child-env whitelist (buildChildEnv), model id
// resolution, and the import.meta.main guard. The daemon's main loop
// (register/heartbeat/claim/spawn) is process+network-bound and is not
// exercised here; importing the module must be inert (guard verified below).
import { describe, expect, it } from "vitest";
import { buildChildEnv, resolveModelId } from "./daemon";

describe("buildChildEnv", () => {
  it("keeps the base allowlist (PATH/HOME/TMPDIR/TERM/LANG) from the daemon env", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/u", TMPDIR: "/tmp", TERM: "xterm", LANG: "en_US.UTF-8" };
    expect(buildChildEnv(env, "/w", null)).toEqual({ ...env, PWD: "/w" });
  });

  it("keeps LC_* vars but drops every other unknown var (closed whitelist)", () => {
    const env = { PATH: "/usr/bin", LC_ALL: "C", LC_MESSAGES: "en", FOO: "bar", EDITOR: "vim", FORGE_RUNTIME_ID: "r1" };
    expect(buildChildEnv(env, "/w", null)).toEqual({ PATH: "/usr/bin", LC_ALL: "C", LC_MESSAGES: "en", PWD: "/w" });
  });

  it("never lets Lexa credentials or secrets reach the child", () => {
    const env = {
      PATH: "/usr/bin",
      LEXA_API_KEY: "lxk_secret",
      LXK_API_KEY: "lxk_secret2",
      LXK_FORGE_DAEMON_TOKEN: "deadbeef",
      LEXA_URL: "http://localhost:3000",
      LEXA_DIR: "/home/u/.lexa",
      GITHUB_PRIVATE_KEY: "-----BEGIN",
      CF_API_TOKEN: "cf-t",
    };
    expect(buildChildEnv(env, "/w", null)).toEqual({ PATH: "/usr/bin", PWD: "/w" });
  });

  it("forces PWD to the spawn cwd, overriding a stale inherited value", () => {
    const env = { PATH: "/usr/bin", PWD: "/stale/daemon/launch/dir" };
    const out = buildChildEnv(env, "/workspace/proj", null);
    expect(out.PWD).toBe("/workspace/proj");
  });

  it("without a sandbox HOME no XDG_* vars are set", () => {
    const out = buildChildEnv({ PATH: "/usr/bin" }, "/w", null);
    expect(Object.keys(out).filter((k) => k.startsWith("XDG_"))).toEqual([]);
    expect(out.HOME).toBeUndefined();
  });

  it("sandbox HOME overrides HOME and pins the XDG_* dirs inside it", () => {
    const env = { PATH: "/usr/bin", HOME: "/real/home" };
    const out = buildChildEnv(env, "/w", "/workspace/proj/.forge");
    expect(out.HOME).toBe("/workspace/proj/.forge");
    expect(out.XDG_CONFIG_HOME).toBe("/workspace/proj/.forge/.config");
    expect(out.XDG_DATA_HOME).toBe("/workspace/proj/.forge/.local/share");
    expect(out.XDG_CACHE_HOME).toBe("/workspace/proj/.forge/.cache");
    expect(out.XDG_STATE_HOME).toBe("/workspace/proj/.forge/.local/state");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("drops undefined values and handles empty input", () => {
    expect(buildChildEnv({ PATH: undefined, TERM: "xterm" }, "/w", null)).toEqual({ TERM: "xterm", PWD: "/w" });
    expect(buildChildEnv({}, "/w", null)).toEqual({ PWD: "/w" });
  });
});

describe("resolveModelId", () => {
  it("returns full provider/model ids and bare ids unchanged", () => {
    expect(resolveModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(resolveModelId("gpt-4o")).toBe("gpt-4o");
    expect(resolveModelId("")).toBe("");
  });
});

describe("import.meta.main guard", () => {
  it("importing the module is inert — main never runs, exports are available", () => {
    // If the guard were missing, the import above would have exited the
    // process (no credentials/machine-id) or started polling the network.
    expect(typeof buildChildEnv).toBe("function");
    expect(typeof resolveModelId).toBe("function");
  });
});
