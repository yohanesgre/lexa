// forge/daemon.ts — the agent child-env whitelist (buildChildEnv), model id
// resolution, claim repo-content writing (writeRepoContent), and the
// import.meta.main guard. The daemon's main loop
// (register/heartbeat/claim/spawn) is process+network-bound and is not
// exercised here; importing the module must be inert (guard verified below).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, resolveModelId, writeRepoContent, deriveServePort, flavorBaseFor, buildMessageBody, parseMessageResponse, buildMessageUrl, abortUrl, buildMintUrl, parseSessionInfo, type ForgeTask } from "./daemon";

const TASK = { id: "t1" } as ForgeTask;

function tmpRun(): string {
  return mkdtempSync(join(tmpdir(), "lexa-forge-daemon-"));
}

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

describe("writeRepoContent", () => {
  it("writes claim files at <runDir>/repo-content/<owner>/<repo>/<path> (incl. nested paths) + MANIFEST", () => {
    const dir = tmpRun();
    try {
      writeRepoContent(dir, TASK, [
        { owner: "yohanesgre", repo: "lexa", path: "README.md", content: "# Lexa" },
        { owner: "yohanesgre", repo: "lexa", path: "server/entry.ts", content: "// entry" },
      ]);
      expect(readFileSync(join(dir, "repo-content", "yohanesgre", "lexa", "README.md"), "utf-8")).toBe("# Lexa");
      expect(readFileSync(join(dir, "repo-content", "yohanesgre", "lexa", "server", "entry.ts"), "utf-8")).toBe("// entry");
      const manifest = readFileSync(join(dir, "repo-content", "MANIFEST.md"), "utf-8");
      expect(manifest).toContain("Repo content fetched from linked GitHub repos at claim time — ground your work in these files.");
      expect(manifest).toContain("- `yohanesgre/lexa/README.md`");
      expect(manifest).toContain("- `yohanesgre/lexa/server/entry.ts`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claim without repoContent creates no repo-content dir; a stale dir is removed", () => {
    const dir = tmpRun();
    try {
      writeRepoContent(dir, TASK, null);
      expect(existsSync(join(dir, "repo-content"))).toBe(false);
      writeRepoContent(dir, TASK, [{ owner: "a", repo: "b", path: "old.md", content: "old" }]);
      expect(existsSync(join(dir, "repo-content", "a", "b", "old.md"))).toBe(true);
      writeRepoContent(dir, TASK, []);
      expect(existsSync(join(dir, "repo-content"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fresh claim wipes the previous claim's repo-content (persistent workspace lifecycle)", () => {
    const dir = tmpRun();
    try {
      writeRepoContent(dir, TASK, [{ owner: "a", repo: "b", path: "old.md", content: "old" }]);
      writeRepoContent(dir, TASK, [{ owner: "a", repo: "b", path: "new.md", content: "new" }]);
      expect(existsSync(join(dir, "repo-content", "a", "b", "old.md"))).toBe(false);
      expect(existsSync(join(dir, "repo-content", "a", "b", "new.md"))).toBe(true);
      const manifest = readFileSync(join(dir, "repo-content", "MANIFEST.md"), "utf-8");
      expect(manifest).not.toContain("old.md");
      expect(manifest).toContain("- `a/b/new.md`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unsafe paths are skipped without a crash and nothing escapes the repo-content dir", () => {
    const dir = tmpRun();
    try {
      writeRepoContent(dir, TASK, [
        { owner: "..", repo: "lexa", path: "x", content: "evil" },
        { owner: "yohanesgre", repo: "..", path: "x", content: "evil" },
        { owner: "yohanesgre", repo: "a/b", path: "x", content: "evil" },
        { owner: "yohanesgre", repo: "lexa", path: "../evil", content: "evil" },
        { owner: "yohanesgre", repo: "lexa", path: "/etc/passwd", content: "evil" },
        { owner: "yohanesgre", repo: "lexa", path: "a/../../b", content: "evil" },
        { owner: "yohanesgre", repo: "lexa", path: "ok.md", content: "fine" },
      ]);
      expect(readFileSync(join(dir, "repo-content", "yohanesgre", "lexa", "ok.md"), "utf-8")).toBe("fine");
      expect(existsSync(join(dir, "evil"))).toBe(false);
      expect(existsSync(join(dir, "repo-content", "evil"))).toBe(false);
      expect(readdirSync(join(dir, "repo-content", "yohanesgre", "lexa"))).toEqual(["ok.md"]);
      const manifest = readFileSync(join(dir, "repo-content", "MANIFEST.md"), "utf-8");
      expect(manifest).not.toContain("evil");
      expect(manifest).toContain("- `yohanesgre/lexa/ok.md`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing file write logs and continues; the MANIFEST lists only written files", () => {
    const dir = tmpRun();
    try {
      writeRepoContent(dir, TASK, [
        { owner: "a", repo: "b", path: "x/y", content: "file" },
        { owner: "a", repo: "b", path: "x/y/z", content: "nested under a file" },
        { owner: "a", repo: "b", path: "fine.md", content: "ok" },
      ]);
      expect(readFileSync(join(dir, "repo-content", "a", "b", "fine.md"), "utf-8")).toBe("ok");
      expect(existsSync(join(dir, "repo-content", "a", "b", "x", "y", "z"))).toBe(false);
      const manifest = readFileSync(join(dir, "repo-content", "MANIFEST.md"), "utf-8");
      expect(manifest).toContain("- `a/b/x/y`");
      expect(manifest).toContain("- `a/b/fine.md`");
      expect(manifest).not.toContain("x/y/z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("flavorBaseFor", () => {
  afterEach(() => {
    delete process.env.LEXA_FLAVOR;
  });

  it("maps legacy flavor roots to bases (path fallback)", () => {
    expect(flavorBaseFor("/home/u/.lexa")).toBe(4096);
    expect(flavorBaseFor("/home/u/.lexa-staging")).toBe(4196);
    expect(flavorBaseFor("/home/u/.lexa-dev")).toBe(4296);
    expect(flavorBaseFor("/custom/lexa-root")).toBe(4096);
  });

  it("LEXA_FLAVOR env wins over the path fallback (host-keyed groups)", () => {
    process.env.LEXA_FLAVOR = "dev";
    expect(flavorBaseFor("/home/u/.lexa/localhost")).toBe(4296);
    process.env.LEXA_FLAVOR = "staging";
    expect(flavorBaseFor("/home/u/.lexa/localhost")).toBe(4196);
    process.env.LEXA_FLAVOR = "prod";
    expect(flavorBaseFor("/home/u/.lexa/lexa.example.com")).toBe(4096);
    // The env also wins over the legacy basename.
    process.env.LEXA_FLAVOR = "dev";
    expect(flavorBaseFor("/home/u/.lexa-staging")).toBe(4296);
  });

  it("an invalid LEXA_FLAVOR falls back to the path parse", () => {
    process.env.LEXA_FLAVOR = "bogus";
    expect(flavorBaseFor("/home/u/.lexa")).toBe(4096);
    expect(flavorBaseFor("/home/u/.lexa-dev")).toBe(4296);
  });
});

describe("deriveServePort", () => {
  it("override wins and is first candidate", () => {
    const ports = deriveServePort("rt-abc", 4096, "4250");
    expect(ports[0]).toBe(4250);
  });
  it("defaults to flavor base + fnv1a(runtimeId)%32, then +1..+4", () => {
    const ports = deriveServePort("rt-abc", 4096);
    expect(ports[0]).toBeGreaterThanOrEqual(4096);
    expect(ports[0]).toBeLessThan(4128);
    expect(ports).toEqual([ports[0], ports[0] + 1, ports[0] + 2, ports[0] + 3, ports[0] + 4]);
  });
  it("stable per runtime id", () => {
    expect(deriveServePort("rt-abc", 4096)[0]).toBe(deriveServePort("rt-abc", 4096)[0]);
  });
});

describe("buildMessageBody", () => {
  it("splits provider/model into an object (string form is rejected by serve)", () => {
    const body = JSON.parse(buildMessageBody("opencode-go/deepseek-v4-flash", "build", "hi")) as {
      model: { providerID: string; modelID: string };
      agent: string;
      parts: Array<{ type: string; text: string }>;
    };
    expect(body.model).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4-flash" });
    expect(body.agent).toBe("build");
    expect(body.parts).toEqual([{ type: "text", text: "hi" }]);
  });
  it("omits an unparseable model (bare id without provider) and empty agent", () => {
    const body = JSON.parse(buildMessageBody("gpt-4o", "", "hi")) as { model?: unknown; agent?: string };
    expect(body.model).toBeUndefined();
    expect(body.agent).toBeUndefined();
  });
});

describe("parseMessageResponse", () => {
  it("joins text parts and ignores step-start/step-finish/reasoning", () => {
    const json = JSON.stringify({
      parts: [
        { type: "step-start" },
        { type: "text", text: "## A" },
        { type: "text", text: "line" },
        { type: "step-finish" },
        { type: "reasoning", text: "hmm" },
      ],
      error: null,
    });
    expect(parseMessageResponse(json)).toEqual({ result: "## A\nline", error: null });
  });
  it("surfaces errors from error.data.message", () => {
    const json = JSON.stringify({ parts: [], error: { name: "Error", data: { message: "boom" } } });
    expect(parseMessageResponse(json)).toEqual({ result: null, error: "boom" });
  });
  it("falls back to error.name when data.message is absent", () => {
    const json = JSON.stringify({ parts: [], error: { name: "SessionNotFoundError" } });
    expect(parseMessageResponse(json)).toEqual({ result: null, error: "SessionNotFoundError" });
  });
  it("caps the joined result at 1MB tail", () => {
    const big = "x".repeat(1024 * 1024 + 100);
    const json = JSON.stringify({ parts: [{ type: "text", text: big }], error: null });
    const { result } = parseMessageResponse(json);
    expect(result?.length).toBe(1024 * 1024);
  });
});

describe("buildMessageUrl", () => {
  it("targets the session", () => {
    expect(buildMessageUrl(4100, "s1")).toBe("http://127.0.0.1:4100/session/s1/message");
  });
});

describe("abortUrl", () => {
  it("targets the session abort endpoint", () => {
    expect(abortUrl(4100, "s1")).toBe("http://127.0.0.1:4100/session/s1/abort");
  });
});

describe("mint helpers", () => {
  it("builds the mint URL with the directory query (URL-encoded)", () => {
    expect(buildMintUrl(4100, "/ws/proj")).toBe("http://127.0.0.1:4100/session?directory=/ws/proj");
    expect(buildMintUrl(4100, "/ws/a b")).toBe("http://127.0.0.1:4100/session?directory=/ws/a%20b");
  });
  it("parses Session.Info and validates the directory", () => {
    expect(parseSessionInfo(`{"id":"s1","directory":"/ws/proj"}`, "/ws/proj")).toEqual({ id: "s1" });
    expect(() => parseSessionInfo(`{"id":"s1","directory":"/elsewhere"}`, "/ws/proj")).toThrow(/directory/i);
    expect(() => parseSessionInfo(`{}`, "/ws/proj")).toThrow(/session/i);
  });
});
