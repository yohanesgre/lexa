import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnvFile,
  DEAD_KEYS,
  EnvFileError,
  formatDotenv,
  formatShellExports,
  parseDotenv,
  parseEnvToml,
  readEnvFile,
  resolveEnvFilePath,
  writeEnvFile,
} from "./env-file";
import { resolveEnvTarget } from "../scripts/setup-cli";
import { getEnv, getEnvFromWorkers, isRuntimeEnvStringKey, RUNTIME_ENV_STRING_KEYS, type RuntimeEnv } from "./env";

const ENV_FILE_CLI = fileURLToPath(new URL("./env-file.ts", import.meta.url));
const ENV_BOOT = fileURLToPath(new URL("./env-boot.ts", import.meta.url));

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lexa-env-file-"));
}

describe("parseEnvToml", () => {
  it("maps sectioned leaves to identity keys, coerces scalars, rejects duplicate leaves naming both, and never echoes secrets", () => {
    const values = parseEnvToml(
      [
        "# comment",
        "[core]",
        'DATABASE_PATH = "./data/x.db"',
        'PORT = "3000"',
        "[limits]",
        "LXK_MAX_BODY_MB = 0",
        "B = false",
        'ARR = ["a", "b"]',
        "EMPTY = []",
        "",
      ].join("\n")
    );
    expect(values).toEqual({
      DATABASE_PATH: "./data/x.db",
      PORT: "3000",
      LXK_MAX_BODY_MB: "0",
      B: "false",
      ARR: "a,b",
      EMPTY: "",
    });

    let err: unknown;
    try {
      parseEnvToml('[core]\nPORT = "1"\n[limits]\nPORT = "2"\n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvFileError);
    const msg = (err as EnvFileError).message;
    expect(msg).toContain("[limits]");
    expect(msg).toContain("[core]");
    expect(msg).toContain("PORT");

    const secret = "SUPERSECRETVALUE";
    let secretMsg = "";
    try {
      parseEnvToml(`[core]\nPORT = "${secret}"\n[limits]\nPORT = "${secret}"\n`);
    } catch (e) {
      secretMsg = (e as Error).message;
    }
    expect(secretMsg).not.toContain(secret);
  });
});

describe("dotenv parse/format", () => {
  it("parses bare/single/double-quoted/export/commented values and round-trips formatDotenv", () => {
    const values = parseDotenv(
      [
        "# comment",
        "PORT=3000",
        "export LOG_LEVEL=debug",
        'A="quoted # not comment"',
        "B='literal $HOME'",
        "C=bare # trailing",
        'D=""',
        "",
      ].join("\n")
    );
    expect(values).toEqual({
      PORT: "3000",
      LOG_LEVEL: "debug",
      A: "quoted # not comment",
      B: "literal $HOME",
      C: "bare",
      D: "",
    });

    const roundTrip = {
      PORT: "3000",
      EMPTY: "",
      QUOTED: 'has space # and "quote"',
      MULTI: "l1\nl2",
      DOLLAR: "$HOME `id` $(echo x)",
    };
    expect(parseDotenv(formatDotenv(roundTrip))).toEqual(roundTrip);
  });
});

describe("formatShellExports", () => {
  it("produces eval-safe single-quoted exports (no command execution)", () => {
    const marker = join(tmpdir(), `lexa-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const value = `line1\nline2 it's $HOME \`id\` $(touch ${marker}) \\ end`;
    const script = `${formatShellExports({ V: value })}\nprintf '%s' "$V"\n`;
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(value);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("applyEnvFile", () => {
  it("never overwrites real env values, prefers .env.toml, and returns a null path (or throws strict) when nothing is found", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { PORT: "2222", LOG_LEVEL: "debug" });
    const env: Record<string, string | undefined> = { PORT: "1111" };
    const res = applyEnvFile({ cwd: dir, env });
    expect(res.path).toBe(join(dir, ".env.toml"));
    expect(res.applied).toEqual(["LOG_LEVEL"]);
    expect(res.skipped).toEqual(["PORT"]);
    expect(env.PORT).toBe("1111");
    expect(env.LOG_LEVEL).toBe("debug");

    writeFileSync(join(dir, ".env"), "PORT=3333\n");
    const env2: Record<string, string | undefined> = {};
    const res2 = applyEnvFile({ cwd: dir, env: env2 });
    expect(res2.path).toBe(join(dir, ".env.toml"));
    expect(env2.PORT).toBe("2222");

    const emptyDir = tmpDir();
    const env3: Record<string, string | undefined> = {};
    expect(applyEnvFile({ cwd: emptyDir, env: env3 })).toEqual({ path: null, applied: [], skipped: [] });
    expect(() => applyEnvFile({ cwd: emptyDir, env: env3, strict: true })).toThrow(EnvFileError);
  });
});

describe("resolveEnvFilePath", () => {
  it("returns null for an empty directory", () => {
    expect(resolveEnvFilePath(tmpDir())).toBeNull();
  });
});

describe("writeEnvFile / readEnvFile", () => {
  it("merges, sections output, writes 0600, and round-trips a multiline PEM byte-exact", () => {
    const dir = tmpDir();
    const path = join(dir, ".env.toml");
    writeEnvFile(path, { DATABASE_PATH: "./data/x.db" });
    writeEnvFile(path, { LOG_LEVEL: "info" });
    expect(readEnvFile(path)).toEqual({ DATABASE_PATH: "./data/x.db", LOG_LEVEL: "info" });
    const text = readFileSync(path, "utf8");
    expect(text.indexOf("[core]")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("[core]")).toBeLessThan(text.indexOf("[logging]"));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
    writeEnvFile(path, { LXK_SECRETS_MASTER_KEY: pem });
    expect(readEnvFile(path).LXK_SECRETS_MASTER_KEY).toBe(pem);
  });

  it("refuses to write the example template", () => {
    const dir = tmpDir();
    const example = join(dir, ".env.toml.example");
    expect(() => writeEnvFile(example, { PORT: "1" })).toThrow(EnvFileError);
    expect(existsSync(example)).toBe(false);
  });
});

describe("resolveEnvTarget", () => {
  it("migrates the sibling .env only for the canonical .env.toml target", () => {
    const custom = tmpDir();
    writeFileSync(join(custom, ".env"), "PORT=3000\n");
    const res = resolveEnvTarget({
      envFileArg: join(custom, ".env.prod.toml"),
      migrateEnvFlag: true,
      interactive: false,
      log: () => {},
    });
    expect(res.envFile).toBe(join(custom, ".env.prod.toml"));
    expect(res.migrated).toBe(false);
    expect(existsSync(join(custom, ".env.toml"))).toBe(false);
    expect(existsSync(join(custom, ".env"))).toBe(true);

    const canonical = tmpDir();
    writeFileSync(join(canonical, ".env"), "PORT=3000\n");
    const res2 = resolveEnvTarget({
      envFileArg: join(canonical, ".env.toml"),
      migrateEnvFlag: true,
      interactive: false,
      log: () => {},
    });
    expect(res2.migrated).toBe(true);
    expect(existsSync(join(canonical, ".env.toml"))).toBe(true);
    expect(existsSync(join(canonical, ".env.legacy"))).toBe(true);
  });
});

describe("env-file boot order (SEV regression)", () => {
  it("exits non-zero naming the path when the resolved .env.toml is unparseable", () => {
    const dir = tmpDir();
    const path = join(dir, ".env.toml");
    writeFileSync(path, "[core]\nPORT = \n");
    const script = join(dir, "probe-bad.ts");
    writeFileSync(script, [`import ${JSON.stringify(ENV_BOOT)};`, 'console.log("should not reach");', ""].join("\n"));
    const res = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(path);
    expect(res.stdout).not.toContain("should not reach");
  });
});

describe("env-file CLI", () => {
  it("--migrate carries live values byte-exact, drops dead keys, renames legacy, and never prints secrets", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    const pem = "-----BEGIN KEY-----\nSECRETLINE\n-----END KEY-----\n";
    const legacyText = [
      "DATABASE_PATH=./data/lexa.db",
      "LXK_ADMIN_EMAILS=ops@example.com",
      "VITE_LXK_API_KEY=dead1",
      "LXK_API_KEY=dead2",
      "RUNTIME_STALE_RUN_MIN=45",
      "GITHUB_APP_ID=dead-github-id",
      "GITHUB_WEBHOOK_SECRET=dead-github-secret",
      "LOG_LEVEL=debug",
      `LXK_SECRETS_MASTER_KEY="${pem.replace(/\n/g, "\\n")}"`,
      "",
    ].join("\n");
    writeFileSync(legacyPath, legacyText);
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(pem);
    expect(existsSync(join(dir, ".env.toml"))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    const legacyDest = join(dir, ".env.legacy");
    expect(existsSync(legacyDest)).toBe(true);
    expect(readFileSync(legacyDest, "utf8")).toBe(legacyText);
    expect(statSync(legacyDest).mode & 0o777).toBe(0o600);
    const migrated = readEnvFile(join(dir, ".env.toml"));
    expect(migrated.LXK_SECRETS_MASTER_KEY).toBe(pem);
    expect(migrated.DATABASE_PATH).toBe("./data/lexa.db");
    expect(migrated.LXK_ADMIN_EMAILS).toBe("ops@example.com");
    expect(migrated.LOG_LEVEL).toBe("debug");
    for (const dead of DEAD_KEYS) expect(Object.hasOwn(migrated, dead)).toBe(false);
    expect(statSync(join(dir, ".env.toml")).mode & 0o777).toBe(0o600);
  });

  it("--migrate refuses to clobber an existing .env.legacy and leaves .env intact", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    writeFileSync(legacyPath, "PORT=3000\n");
    writeFileSync(join(dir, ".env.legacy"), "OLD=1\n");
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(join(dir, ".env.toml"))).toBe(false);
  });

  it("--migrate refuses an existing .env.toml without --force", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    writeFileSync(legacyPath, "PORT=3000\n");
    writeEnvFile(join(dir, ".env.toml"), { LOG_LEVEL: "debug" });
    const before = readFileSync(join(dir, ".env.toml"), "utf8");
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("already exists");
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(join(dir, ".env.toml"), "utf8")).toBe(before);
  });

  it("--check never prints values", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { LOG_LEVEL: "secret-level" });
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", join(dir, ".env.toml"), "--check"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("secret-level");
    expect(res.stdout).toContain("LOG_LEVEL");
  });
});

describe("env builders (snapshot contract)", () => {
  it("map an explicit source without process.env and preserve per-path differences", () => {
    const rt = getEnv({ DATABASE_PATH: "/tmp/x.db", LXK_PUBLIC_URL: "https://lexa.example.com", LXK_MAX_BODY_MB: "32", LOG_LEVEL: "debug" });
    expect(rt.DATABASE_PATH).toBe("/tmp/x.db");
    expect(rt.LXK_PUBLIC_URL).toBe("https://lexa.example.com");
    expect(rt.LXK_MAX_BODY_MB).toBe("32");
    expect(rt.LOG_LEVEL).toBe("debug");

    const fakeDb = { kind: "d1" };
    const workers = getEnvFromWorkers({ LXK_ENV: "prod", DB: fakeDb, DATABASE_PATH: "/tmp/x.db", CRON_SECRET: "cron" });
    expect(workers.LXK_ENV).toBe("prod");
    expect(workers.CRON_SECRET).toBe("cron");
    expect(workers.DB).toBe(fakeDb);
    // Workers drops Bun-only keys and forces the r2 storage driver.
    expect(workers.DATABASE_PATH).toBeUndefined();
    expect(workers.LXK_STORAGE_DRIVER).toBe("r2");
  });

  it("RUNTIME_ENV_STRING_KEYS is exactly the string slots both builders copy — never a binding or a dropped legacy name", () => {
    const source = Object.fromEntries(RUNTIME_ENV_STRING_KEYS.map((k) => [k, `v-${k}`]));
    const snapshots: Array<[string, RuntimeEnv]> = [
      ["getEnv", getEnv(source as Record<string, string | undefined>)],
      ["getEnvFromWorkers", getEnvFromWorkers(source)],
    ];
    for (const [name, env] of snapshots) {
      // Nothing either builder copies as a string may be outside the list.
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue;
        expect(RUNTIME_ENV_STRING_KEYS, `${name} copies ${key}`).toContain(key);
      }
    }
    // Every listed name is really copied on at least one path.
    for (const key of RUNTIME_ENV_STRING_KEYS) {
      expect(snapshots.some(([, env]) => env[key] === `v-${key}`), key).toBe(true);
    }
    // Never a Workers binding nor an arbitrary host name.
    for (const binding of ["DB", "BLOB", "KV", "LINEAR_TOKEN", "MCP_REMOTE_TOKEN", "LXK_TANSTACK_AI_DEBUG"]) {
      expect(isRuntimeEnvStringKey(binding), binding).toBe(false);
    }
    // Jev config is DB-only now; its legacy slots must not survive as env names.
    const legacy = [
      ["TYPESAFE", "API", "KEY"].join("_"),
      ["TYPESAFE", "BASE", "URL"].join("_"),
      ["TYPESAFE", "DEFAULT", "MODEL"].join("_"),
    ];
    for (const key of legacy) {
      expect(RUNTIME_ENV_STRING_KEYS).not.toContain(key);
      expect(isRuntimeEnvStringKey(key), key).toBe(false);
    }
  });

  it("carries both secrets master keys on both builder paths", () => {
    expect(RUNTIME_ENV_STRING_KEYS).toContain("LXK_SECRETS_MASTER_KEY");
    // The MCP-scoped name is gone with no alias (spelled from fragments).
    const legacyMcpMasterKey = ["LXK", "MCP", "MASTER", "KEY"].join("_");
    expect(RUNTIME_ENV_STRING_KEYS).not.toContain(legacyMcpMasterKey);
    const source = { LXK_SECRETS_MASTER_KEY: "active-key", LXK_SECRETS_MASTER_KEY_PREV: "prev-key" };
    for (const env of [getEnv(source), getEnvFromWorkers(source)]) {
      expect(env.LXK_SECRETS_MASTER_KEY).toBe("active-key");
      expect(env.LXK_SECRETS_MASTER_KEY_PREV).toBe("prev-key");
      for (const key of ["LXK_SECRETS_MASTER_KEY", "LXK_SECRETS_MASTER_KEY_PREV"]) {
        expect(isRuntimeEnvStringKey(key), key).toBe(true);
      }
    }
    // Unset on both paths is a clean undefined — "feature disabled", never empty.
    for (const env of [getEnv({}), getEnvFromWorkers({})]) {
      expect(env.LXK_SECRETS_MASTER_KEY).toBeUndefined();
      expect(env.LXK_SECRETS_MASTER_KEY_PREV).toBeUndefined();
    }
  });
});
