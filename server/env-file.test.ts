import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnvFile,
  assertEnvWriteTarget,
  DEAD_KEYS,
  describeKeys,
  EnvFileError,
  ENV_SECTION_ORDER,
  formatDotenv,
  formatShellExports,
  parseDotenv,
  parseEnvToml,
  readEnvFile,
  resolveEnvFilePath,
  stringifyTomlFallback,
  writeEnvFile,
} from "./env-file";
import { resolveEnvTarget, writeEnvByPath } from "../scripts/setup-cli";
import { RUNTIME_ENV_STRING_KEYS } from "./env";

const ENV_FILE_CLI = fileURLToPath(new URL("./env-file.ts", import.meta.url));
const ENV_BOOT = fileURLToPath(new URL("./env-boot.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("./entry.ts", import.meta.url));
const AUTH_MODULE = fileURLToPath(new URL("./auth.ts", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../.env.toml.example", import.meta.url));
const EXAMPLE_ALLOWLIST = ["COMPOSE_PROJECT_NAME", "LXK_IMAGE_TAG", "CF_TUNNEL_TOKEN"];

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lexa-env-file-"));
}

describe("parseEnvToml", () => {
  it("maps sectioned leaves to identity keys and coerces scalars", () => {
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
  });

  it("accepts root-level scalars", () => {
    expect(parseEnvToml('LOG_LEVEL = "debug"')).toEqual({ LOG_LEVEL: "debug" });
  });

  it("rejects a duplicate leaf across sections and names both", () => {
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
  });

  it("rejects nested tables, bad key names, dates, and mixed arrays", () => {
    expect(() => parseEnvToml('[a.b]\nK = "x"\n')).toThrow(EnvFileError);
    expect(() => parseEnvToml('[core]\nlowercase = "x"\n')).toThrow(EnvFileError);
    expect(() => parseEnvToml("[core]\nD = 1979-05-27T07:32:00Z\n")).toThrow(EnvFileError);
    expect(() => parseEnvToml("[core]\nK = [1, { x = 1 }]\n")).toThrow(EnvFileError);
    expect(() => parseEnvToml("[core]\nK = ")).toThrow(EnvFileError);
  });

  it("never echoes secret values in error text", () => {
    const secret = "SUPERSECRETVALUE";
    let msg = "";
    try {
      parseEnvToml(`[core]\nPORT = "${secret}"\n[limits]\nPORT = "${secret}"\n`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(secret);
  });

  it("parses a multiline basic string (PEM-friendly)", () => {
    const values = parseEnvToml('[github]\nGITHUB_PRIVATE_KEY = """line1\nline2\n"""\n');
    expect(values.GITHUB_PRIVATE_KEY).toBe("line1\nline2\n");
  });
});

describe("parseDotenv", () => {
  it("parses bare, single-, double-quoted, export-prefixed values and comments", () => {
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
  });

  it("unescapes and spans lines for quoted values", () => {
    const values = parseDotenv('PEM="-----BEGIN-----\nAAA\n-----END-----"\nNEXT=1\n');
    expect(values.PEM).toBe("-----BEGIN-----\nAAA\n-----END-----");
    expect(values.NEXT).toBe("1");
  });

  it("throws on malformed lines without echoing values", () => {
    expect(() => parseDotenv("NO_EQUALS_HERE\n")).toThrow(EnvFileError);
    expect(() => parseDotenv('K="unterminated\n')).toThrow(EnvFileError);
  });
});

describe("formatDotenv", () => {
  it("round-trips empty, bare, and quoted values", () => {
    const values = {
      PORT: "3000",
      EMPTY: "",
      QUOTED: 'has space # and "quote"',
      MULTI: "l1\nl2",
      DOLLAR: "$HOME `id` $(echo x)",
    };
    expect(parseDotenv(formatDotenv(values))).toEqual(values);
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
  it("never overwrites real environment values and reports applied/skipped", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { PORT: "2222", LOG_LEVEL: "debug" });
    const env: Record<string, string | undefined> = { PORT: "1111" };
    const res = applyEnvFile({ cwd: dir, env });
    expect(res.path).toBe(join(dir, ".env.toml"));
    expect(res.applied).toEqual(["LOG_LEVEL"]);
    expect(res.skipped).toEqual(["PORT"]);
    expect(env.PORT).toBe("1111");
    expect(env.LOG_LEVEL).toBe("debug");
  });

  it("prefers .env.toml over legacy .env", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { PORT: "2222" });
    writeFileSync(join(dir, ".env"), "PORT=3333\n");
    const env: Record<string, string | undefined> = {};
    const res = applyEnvFile({ cwd: dir, env });
    expect(res.path).toBe(join(dir, ".env.toml"));
    expect(env.PORT).toBe("2222");
  });

  it("falls back to legacy .env for one release", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "PORT=3333\n");
    const env: Record<string, string | undefined> = {};
    const res = applyEnvFile({ cwd: dir, env });
    expect(res.path).toBe(join(dir, ".env"));
    expect(env.PORT).toBe("3333");
  });

  it("returns a null path (or throws in strict mode) when nothing is found", () => {
    const dir = tmpDir();
    const env: Record<string, string | undefined> = {};
    expect(applyEnvFile({ cwd: dir, env })).toEqual({ path: null, applied: [], skipped: [] });
    expect(() => applyEnvFile({ cwd: dir, env, strict: true })).toThrow(EnvFileError);
  });

  it("throws for an explicit missing path", () => {
    const dir = tmpDir();
    expect(() => applyEnvFile({ path: join(dir, "nope.toml"), env: {} })).toThrow(EnvFileError);
  });
});

describe("resolveEnvFilePath", () => {
  it("returns null for an empty directory", () => {
    expect(resolveEnvFilePath(tmpDir())).toBeNull();
  });
});

describe("writeEnvFile / readEnvFile", () => {
  it("merges into an existing file, sections output, and writes 0600", () => {
    const dir = tmpDir();
    const path = join(dir, ".env.toml");
    writeEnvFile(path, { DATABASE_PATH: "./data/x.db" });
    writeEnvFile(path, { LOG_LEVEL: "info" });
    expect(readEnvFile(path)).toEqual({ DATABASE_PATH: "./data/x.db", LOG_LEVEL: "info" });
    const text = readFileSync(path, "utf8");
    expect(text.indexOf("[core]")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("[core]")).toBeLessThan(text.indexOf("[logging]"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to write the example template", () => {
    const dir = tmpDir();
    const example = join(dir, ".env.toml.example");
    expect(() => writeEnvFile(example, { PORT: "1" })).toThrow(EnvFileError);
    expect(existsSync(example)).toBe(false);
  });

  it("round-trips a multiline PEM value byte-exact", () => {
    const dir = tmpDir();
    const path = join(dir, ".env.toml");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
    writeEnvFile(path, { GITHUB_PRIVATE_KEY: pem });
    expect(readEnvFile(path).GITHUB_PRIVATE_KEY).toBe(pem);
  });

  it("is byte-exact against a legacy dotenv fixture (legacy parity)", () => {
    const dir = tmpDir();
    const legacy = [
      "DATABASE_PATH=./data/lexa.db",
      "LXK_ADMIN_EMAILS=ops@example.com",
      "LOG_LEVEL=debug",
      "GITHUB_WEBHOOK_SECRET=abc123",
      'GITHUB_PRIVATE_KEY="line1\\nline2"',
      "",
    ].join("\n");
    const parsed = parseDotenv(legacy);
    const path = join(dir, ".env.toml");
    writeEnvFile(path, parsed);
    expect(readEnvFile(path)).toEqual(parsed);
  });

  it("refuses to write keys the loader cannot read back", () => {
    const dir = tmpDir();
    const path = join(dir, ".env.toml");
    expect(() => writeEnvFile(path, { _FOO: "x" })).toThrow(EnvFileError);
    expect(() => writeEnvFile(path, { lowercase: "x" })).toThrow(EnvFileError);
    expect(existsSync(path)).toBe(false);
  });
});

describe("write guard via temp+rename", () => {
  it("refuses the example template before creating the temp file", () => {
    const dir = tmpDir();
    const example = join(dir, ".env.toml.example");
    writeFileSync(example, "# tracked template\n");
    expect(() => writeEnvByPath(example, { PORT: "1" })).toThrow(EnvFileError);
    expect(readFileSync(example, "utf8")).toBe("# tracked template\n");
    expect(existsSync(`${example}.tmp-${process.pid}`)).toBe(false);
  });

  it("assertEnvWriteTarget accepts ordinary paths and rejects the example", () => {
    const dir = tmpDir();
    expect(() => assertEnvWriteTarget(join(dir, ".env.toml"))).not.toThrow();
    expect(() => assertEnvWriteTarget(join(dir, ".env.prod.toml"))).not.toThrow();
    expect(() => assertEnvWriteTarget(join(dir, ".env.toml.example"))).toThrow(EnvFileError);
  });
});

describe("resolveEnvTarget", () => {
  it("does not migrate the sibling .env for a custom --env-file target", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "PORT=3000\n");
    const res = resolveEnvTarget({
      envFileArg: join(dir, ".env.prod.toml"),
      migrateEnvFlag: true,
      interactive: false,
      log: () => {},
    });
    expect(res.envFile).toBe(join(dir, ".env.prod.toml"));
    expect(res.migrated).toBe(false);
    expect(existsSync(join(dir, ".env.toml"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(true);
  });

  it("migrates the sibling .env for the canonical .env.toml target", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, ".env"), "PORT=3000\n");
    const res = resolveEnvTarget({
      envFileArg: join(dir, ".env.toml"),
      migrateEnvFlag: true,
      interactive: false,
      log: () => {},
    });
    expect(res.migrated).toBe(true);
    expect(existsSync(join(dir, ".env.toml"))).toBe(true);
    expect(existsSync(join(dir, ".env.legacy"))).toBe(true);
  });
});

describe("env-file boot order (SEV regression)", () => {
  it("keeps ./env-boot as the FIRST import in entry.ts", () => {
    const source = readFileSync(ENTRY, "utf8");
    const firstImport = /^\s*import\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/m.exec(source);
    expect(firstImport?.[1]).toBe("./env-boot");
  });

  it("populates the auth module constant from a file-only value", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { LXK_PUBLIC_URL: "http://file-only.example.test" });
    const script = join(dir, "probe.ts");
    writeFileSync(
      script,
      [
        `import ${JSON.stringify(ENV_BOOT)};`,
        `const { PUBLIC_URL } = await import(${JSON.stringify(AUTH_MODULE)});`,
        'console.log("PUBLIC_URL=" + PUBLIC_URL);',
        "",
      ].join("\n")
    );
    const res = spawnSync("bun", [script], { cwd: dir, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("PUBLIC_URL=http://file-only.example.test");
  });
});

describe("describeKeys", () => {
  it("prints names and lengths only", () => {
    expect(describeKeys({ A: "xyz" })).toEqual(["A (3 chars)"]);
  });
});

describe("section mapping", () => {
  it("has a section for every runtime key and a stable order", () => {
    expect(ENV_SECTION_ORDER[0]).toBe("core");
    expect(ENV_SECTION_ORDER).toContain("workers");
  });
});

describe(".env.toml.example drift guard", () => {
  const text = readFileSync(EXAMPLE, "utf8");
  const present = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) present.add(m[1]!);
  }

  it("lists every RuntimeEnv string key (active or commented)", () => {
    const missing = RUNTIME_ENV_STRING_KEYS.filter((k) => !present.has(k));
    expect(missing).toEqual([]);
  });

  it("contains no keys outside RuntimeEnv + the tooling allowlist", () => {
    const allowed = new Set<string>([...RUNTIME_ENV_STRING_KEYS, ...EXAMPLE_ALLOWLIST]);
    const extra = [...present].filter((k) => !allowed.has(k));
    expect(extra).toEqual([]);
  });

  it("contains no dead RUNTIME_/HEARTH_ keys", () => {
    const dead = [...present].filter((k) => k.startsWith("RUNTIME_") || k.startsWith("HEARTH_") || DEAD_KEYS.includes(k));
    expect(dead).toEqual([]);
  });

  it("parses clean and shares the loader's section order", () => {
    const active = parseEnvToml(text);
    expect(Object.keys(active).length).toBeGreaterThan(0);
    for (const key of Object.keys(active)) expect(present.has(key)).toBe(true);
    expect(text.indexOf("[core]")).toBeLessThan(text.indexOf("[auth]"));
    expect(text.indexOf("[auth]")).toBeLessThan(text.indexOf("[urls]"));
    expect(text.indexOf("[urls]")).toBeLessThan(text.indexOf("[github]"));
  });
});

describe("fallback codec parity with Bun.TOML", () => {
  it("matches Bun.TOML where Bun is available (skipped under node/vitest)", () => {
    const g = globalThis as { Bun?: { TOML?: { parse: (t: string) => unknown; stringify: (v: unknown) => string } } };
    const bunToml = g.Bun?.TOML;
    if (!bunToml) return;
    const sample = '[core]\nPORT = "3000"\n[limits]\nZ = 0\nB = false\nA = ["x", "y"]\n';
    const viaBun = parseEnvToml(sample);
    const saved = bunToml;
    (g.Bun as { TOML?: unknown }).TOML = undefined;
    try {
      expect(parseEnvToml(sample)).toEqual(viaBun);
      const doc = { core: { PORT: "3000" }, logging: { LOG_LEVEL: "info" } };
      expect(saved.parse(stringifyTomlFallback(doc))).toEqual(saved.parse(saved.stringify(doc)));
    } finally {
      (g.Bun as { TOML?: unknown }).TOML = saved;
    }
  });
});

describe("env-file CLI", () => {
  it("--migrate carries live values byte-exact, drops dead keys, and renames legacy", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    const pem = "-----BEGIN KEY-----\nSECRETLINE\n-----END KEY-----\n";
    const legacyText = [
      "DATABASE_PATH=./data/lexa.db",
      "LXK_ADMIN_EMAILS=ops@example.com",
      "VITE_LXK_API_KEY=dead1",
      "LXK_API_KEY=dead2",
      "RUNTIME_STALE_RUN_MIN=45",
      "LOG_LEVEL=debug",
      `LXK_MCP_MASTER_KEY="${pem.replace(/\n/g, "\\n")}"`,
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
    expect(migrated.LXK_MCP_MASTER_KEY).toBe(pem);
    expect(migrated.DATABASE_PATH).toBe("./data/lexa.db");
    expect(migrated.LXK_ADMIN_EMAILS).toBe("ops@example.com");
    expect(migrated.LOG_LEVEL).toBe("debug");
    for (const dead of DEAD_KEYS) expect(Object.hasOwn(migrated, dead)).toBe(false);
    expect(statSync(join(dir, ".env.toml")).mode & 0o777).toBe(0o600);
  });

  it("--migrate --dry-run writes nothing", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    writeFileSync(legacyPath, "PORT=3000\n");
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate", "--dry-run"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dry-run OK");
    expect(existsSync(join(dir, ".env.toml"))).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
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

  it("--migrate --force backs up the existing .env.toml and keeps rollback truthful", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    writeFileSync(legacyPath, "PORT=3000\n");
    writeEnvFile(join(dir, ".env.toml"), { LOG_LEVEL: "debug" });
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate", "--force"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const backup = join(dir, ".env.toml.bak");
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toContain("LOG_LEVEL");
    expect(res.stdout).toContain(".env.toml.bak");
    const migrated = readEnvFile(join(dir, ".env.toml"));
    expect(migrated.PORT).toBe("3000");
    expect(migrated.LOG_LEVEL).toBe("debug");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(dir, ".env.legacy"))).toBe(true);
  });

  it("--migrate rejects unrepresentable legacy keys without writing or renaming", () => {
    const dir = tmpDir();
    const legacyPath = join(dir, ".env");
    writeFileSync(legacyPath, "PORT=3000\n_FOO=bar\n");
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", legacyPath, "--migrate"], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("_FOO");
    expect(res.stderr).not.toContain("bar");
    expect(existsSync(join(dir, ".env.toml"))).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
  });

  it("--path without a value exits 2 with usage", () => {
    const res = spawnSync("bun", [ENV_FILE_CLI, "--check", "--path"], { encoding: "utf8" });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--path requires a value");
  });

  it("--export-shell prints eval-safe exports", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { PORT: "3000", Q: "it's" });
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", join(dir, ".env.toml"), "--export-shell"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const script = `${res.stdout}\nprintf '%s' "$Q"\n`;
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(out.stdout).toBe("it's");
  });

  it("--check never prints values", () => {
    const dir = tmpDir();
    writeEnvFile(join(dir, ".env.toml"), { LOG_LEVEL: "secret-level" });
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", join(dir, ".env.toml"), "--check"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("secret-level");
    expect(res.stdout).toContain("LOG_LEVEL");
  });

  it("exits non-zero on a malformed file", () => {
    const dir = tmpDir();
    const bad = join(dir, ".env.toml");
    writeFileSync(bad, "[core]\nPORT = \n");
    const res = spawnSync("bun", [ENV_FILE_CLI, "--path", bad, "--check"], { encoding: "utf8" });
    expect(res.status).toBe(1);
  });
});
