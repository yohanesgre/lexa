// Unit tests for the pure selectors in scripts/lib/cf-deploy.ts (the workers
// provisioning core) and for the thin entry wrapper scripts/workers-install.ts.
//
// cf-deploy.ts has no top-level runtime side effects, so importing it here is
// inert (and the dedicated test below pins that against the entry script). Run
// with `bun test scripts/workers-install.test.ts` (invoked from
// scripts/test-install.sh, the CI `install-script` job).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  accountAmbiguousMessage,
  accountStaleMessage,
  buildDeployConfig,
  buildDoRemovalMigrations,
  d1AmbiguousMessage,
  readDeployVersion,
  readPackageVersion,
  readPriorAccount,
  readPriorDeployConfig,
  readRootWranglerConfig,
  resolveAccountOrDie,
  resolveDeployVars,
  resolveNames,
  resolveObservability,
  selectAccount,
  selectD1,
  type AccountRow,
  type D1Row,
  type RootWorkerConfig,
} from "./lib/cf-deploy";

function row(name: string): D1Row {
  return { uuid: `uuid-${name}`, name };
}

describe("selectD1", () => {
  test("exact match is reused", () => {
    const selection = selectD1("lexa", [row("lexa"), row("other")]);
    expect(selection).toEqual({ kind: "exact", db: row("lexa") });
  });

  test("exact match wins over a prefixed candidate", () => {
    const selection = selectD1("lexa", [row("lexa-prod"), row("lexa")]);
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") expect(selection.db.name).toBe("lexa");
  });

  test("sole prefixed candidate is reused (live continuity: lexa → lexa-prod)", () => {
    const selection = selectD1("lexa", [row("lexa-prod")]);
    expect(selection).toEqual({ kind: "sole", db: row("lexa-prod") });
  });

  test("several candidates are ambiguous", () => {
    const selection = selectD1("lexa", [row("lexa-prod"), row("lexa-staging")]);
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") expect(selection.names).toEqual(["lexa-prod", "lexa-staging"]);
  });

  test("no candidate is none — unrelated names do not match", () => {
    expect(selectD1("lexa", [row("other"), row("unrelated-db")])).toEqual({ kind: "none" });
  });

  test("the prefix boundary is exact — 'lexa' does not match 'lexa2'", () => {
    expect(selectD1("lexa", [row("lexa2")])).toEqual({ kind: "none" });
  });

  test("flavor alias keeps prod/staging exact (prod → lexa-prod)", () => {
    expect(resolveNames("prod").d1Name).toBe("lexa-prod");
    expect(selectD1("lexa-prod", [row("lexa-prod"), row("lexa-staging")])).toEqual({
      kind: "exact",
      db: row("lexa-prod"),
    });
  });
});

describe("d1AmbiguousMessage", () => {
  test("names the candidates and tells the operator how out", () => {
    const msg = d1AmbiguousMessage("lexa", ["lexa-prod", "lexa-staging"]);
    expect(msg).toContain("lexa-prod");
    expect(msg).toContain("lexa-staging");
    expect(msg).toContain("--name");
    expect(msg).toContain("remove the stale one");
  });

  test("guidance is a distinct deployment, never the prod/staging aliases", () => {
    const msg = d1AmbiguousMessage("lexa", ["lexa-prod", "lexa-staging"]);
    expect(msg).toContain("--name <deploy>");
    expect(msg).toContain("distinct deployment");
    expect(msg).not.toContain("--name prod");
    expect(msg).not.toContain("--name staging");
  });
});

describe("resolveNames", () => {
  test("a plain deploy name maps uniformly", () => {
    expect(resolveNames("acme")).toEqual({
      workerName: "acme",
      d1Name: "acme",
      r2Name: "acme-blobs",
      kvTitle: "acme",
    });
  });
});

function acct(id: string, name?: string): AccountRow {
  return name === undefined ? { id } : { id, name };
}

const A = acct("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Production");
const B = acct("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Personal");

describe("selectAccount", () => {
  test("--account flag wins and must be on the token", () => {
    expect(
      selectAccount({ flag: B.id, accounts: [A, B] }),
    ).toEqual({ kind: "resolved", id: B.id });
  });

  test("CLOUDFLARE_ACCOUNT_ID env resolves when there is no flag", () => {
    expect(
      selectAccount({ env: B.id, accounts: [A, B] }),
    ).toEqual({ kind: "resolved", id: B.id });
  });

  test("prior deploy config resolves when there is no flag/env", () => {
    expect(
      selectAccount({ priorConfig: A.id, accounts: [A, B] }),
    ).toEqual({ kind: "resolved", id: A.id });
  });

  test("flag beats env and prior config", () => {
    expect(
      selectAccount({ flag: B.id, env: A.id, priorConfig: A.id, accounts: [A, B] }),
    ).toEqual({ kind: "resolved", id: B.id });
  });

  test("env beats prior config", () => {
    expect(
      selectAccount({ env: A.id, priorConfig: B.id, accounts: [A, B] }),
    ).toEqual({ kind: "resolved", id: A.id });
  });

  test("exactly one account on the token is used", () => {
    expect(selectAccount({ accounts: [A] })).toEqual({
      kind: "resolved",
      id: A.id,
    });
  });

  test("several accounts headless are ambiguous (never accounts[0])", () => {
    const selection = selectAccount({ accounts: [A, B] });
    expect(selection).toEqual({ kind: "ambiguous", accounts: [A, B] });
  });

  test("an explicit id not on the token is stale", () => {
    const selection = selectAccount({ flag: "deadbeef", accounts: [A, B] });
    expect(selection).toEqual({ kind: "stale", id: "deadbeef" });
  });

  test("a prior config id not accessible by the token is stale", () => {
    const selection = selectAccount({ priorConfig: "deadbeef", accounts: [A] });
    expect(selection).toEqual({ kind: "stale", id: "deadbeef" });
  });

  test("no explicit id and no accounts is none", () => {
    expect(selectAccount({ accounts: [] })).toEqual({ kind: "none" });
  });
});

describe("account messages", () => {
  test("ambiguous names every account and the two ways to choose", () => {
    const msg = accountAmbiguousMessage([A, B]);
    expect(msg).toContain(A.id);
    expect(msg).toContain(B.id);
    expect(msg).toContain("Production");
    expect(msg).toContain("--account");
    expect(msg).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("stale names the id, what the token sees, and the recovery", () => {
    const msg = accountStaleMessage("deadbeef", [A]);
    expect(msg).toContain("deadbeef");
    expect(msg).toContain(A.id);
    expect(msg).toContain("--account");
    expect(msg).toContain("wrangler login");
  });

  test("stale with no accounts on the token branches the copy", () => {
    const msg = accountStaleMessage("deadbeef", []);
    expect(msg).toContain("sees no accounts");
    expect(msg).toContain("wrangler login");
    expect(msg).not.toContain("for one of those");
  });
});

describe("resolveAccountOrDie", () => {
  test("a resolved selection returns the id", () => {
    expect(resolveAccountOrDie({ kind: "resolved", id: A.id }, [A, B])).toBe(
      A.id,
    );
  });
});

describe("readPriorAccount", () => {
  test("reads account_id from the previous deploy config", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-acct-"));
    mkdirSync(join(dir, "deploy-lexa"));
    writeFileSync(
      join(dir, "deploy-lexa", "wrangler.lexa.json"),
      JSON.stringify({ name: "lexa", account_id: A.id }),
    );
    expect(readPriorAccount(dir, "lexa")).toBe(A.id);
  });

  test("missing config reads empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-acct-"));
    expect(readPriorAccount(dir, "lexa")).toBe("");
  });
});

describe("readPriorDeployConfig (DO history read before staging)", () => {
  test("reads account_id and the DO migration history, and drives the delete-class append", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-prior-"));
    const deployDir = join(dir, "deploy-lexa");
    mkdirSync(deployDir);
    writeFileSync(
      join(deployDir, "wrangler.lexa.json"),
      JSON.stringify({
        name: "lexa",
        account_id: A.id,
        durable_objects: {
          bindings: [
            { name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] }],
      }),
    );
    const prior = readPriorDeployConfig(dir, "lexa");
    expect(prior?.account_id).toBe(A.id);
    expect(readPriorAccount(dir, "lexa")).toBe(A.id);
    expect(buildDoRemovalMigrations(prior ?? {})).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
    ]);
  });

  test("a never-DO prior config yields no migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-prior-"));
    const deployDir = join(dir, "deploy-lexa");
    mkdirSync(deployDir);
    writeFileSync(
      join(deployDir, "wrangler.lexa.json"),
      JSON.stringify({ name: "lexa", account_id: A.id }),
    );
    expect(buildDoRemovalMigrations(readPriorDeployConfig(dir, "lexa") ?? {})).toBeUndefined();
  });

  test("absent config reads null", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-prior-"));
    expect(readPriorDeployConfig(dir, "lexa")).toBeNull();
  });
});

describe("buildDoRemovalMigrations (DO-era detection)", () => {
  const CLASS = "LexaAssistantAgent";

  test("binding-only (no history) → v1 delete", () => {
    expect(
      buildDoRemovalMigrations({ durable_objects: { bindings: [{ name: "ASSISTANT_AGENT", class_name: CLASS }] } }),
    ).toEqual([{ tag: "v1", deleted_classes: [CLASS] }]);
  });

  test("create history, no binding → next tag", () => {
    expect(buildDoRemovalMigrations({ migrations: [{ tag: "v1", new_sqlite_classes: [CLASS] }] })).toEqual([
      { tag: "v1", new_sqlite_classes: [CLASS] },
      { tag: "v2", deleted_classes: [CLASS] },
    ]);
  });

  test("deeper history whose last mention is a create → next tag after the highest", () => {
    const prior = {
      migrations: [
        { tag: "v1", new_sqlite_classes: [CLASS] },
        { tag: "v2", deleted_classes: ["SomeOtherClass"] },
        { tag: "v3", new_classes: [CLASS] },
      ],
    };
    expect(buildDoRemovalMigrations(prior)).toEqual([
      ...prior.migrations,
      { tag: "v4", deleted_classes: [CLASS] },
    ]);
  });

  test("repeat upgrade (create then delete, no binding) → prior verbatim, NO new tag", () => {
    const prior = {
      migrations: [
        { tag: "v1", new_sqlite_classes: [CLASS] },
        { tag: "v2", deleted_classes: [CLASS] },
      ],
    };
    const out = buildDoRemovalMigrations(prior);
    expect(out).toEqual(prior.migrations);
    expect(out).toHaveLength(2);
    expect(out?.some((m) => (m as { tag?: string }).tag === "v3")).toBe(false);
    // The applied history array is returned as-is.
    expect(out).toBe(prior.migrations);
  });

  test("never mentioned → undefined", () => {
    expect(buildDoRemovalMigrations({})).toBeUndefined();
    expect(
      buildDoRemovalMigrations({
        durable_objects: { bindings: [{ class_name: "OtherAgent" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["OtherAgent"] }],
      }),
    ).toBeUndefined();
  });
});

describe("root wrangler observability", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  test("root wrangler.jsonc pins the project defaults (Cloudflare defaults + redact_query_string)", () => {
    expect(readRootWranglerConfig(ROOT).observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
      },
      traces: {
        enabled: true,
        head_sampling_rate: 1,
        persist: true,
      },
      issues: { enabled: true },
    });
  });

  test("the generated per-deploy config mirrors root's block", () => {
    const root = readRootWranglerConfig(ROOT);
    expect(resolveObservability(root)).toEqual(root.observability!);
  });

  test("a root config without observability falls back to bare enable", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-obs-"));
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "name": "lexa" }\n');
    expect(resolveObservability(readRootWranglerConfig(dir))).toEqual({
      enabled: true,
    });
  });

  test("a present but non-object observability block fails loud", () => {
    const root = { observability: "enabled" } as unknown as RootWorkerConfig;
    expect(() => resolveObservability(root)).toThrow(/observability/);
  });
});

describe("readRootWranglerConfig JSONC scanner", () => {
  function configDir(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "wi-jsonc-"));
    writeFileSync(join(dir, "wrangler.jsonc"), content);
    return dir;
  }
  // These cases exercise arbitrary configs, not just RootWorkerConfig's two keys.
  function read(dir: string): Record<string, unknown> {
    return readRootWranglerConfig(dir) as Record<string, unknown>;
  }

  test("a string value containing // parses (a URL is not a comment)", () => {
    const dir = configDir(
      '{\n  "vars": { "LXK_PUBLIC_URL": "https://lexa.example.com//x" }\n}\n',
    );
    expect(read(dir)).toEqual({
      vars: { LXK_PUBLIC_URL: "https://lexa.example.com//x" },
    });
  });

  test("block comments are stripped", () => {
    const dir = configDir('{\n  /* c */ "name": "lexa" /* trailing */\n}\n');
    expect(read(dir)).toEqual({ name: "lexa" });
  });

  test("trailing commas are accepted", () => {
    const dir = configDir('{\n  "name": "lexa",\n  "vars": { "A": "b", },\n}\n');
    expect(read(dir)).toEqual({
      name: "lexa",
      vars: { A: "b" },
    });
  });

  test("malformed JSON throws a message naming wrangler.jsonc", () => {
    const dir = configDir('{ "name": }\n');
    expect(() => readRootWranglerConfig(dir)).toThrow(/wrangler\.jsonc/);
  });
});

describe("per-deploy version marker + public URL (LX-36)", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const ROOT_VERSION = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      version: string;
    }
  ).version;

  test("readDeployVersion reads the repo package.json", () => {
    expect(readDeployVersion(ROOT)).toBe(ROOT_VERSION);
  });

  test("readDeployVersion falls back to the module's repo when the dir has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-ver-"));
    expect(readDeployVersion(dir)).toBe(ROOT_VERSION);
  });

  test("readPackageVersion returns null when no candidate carries a version", () => {
    expect(readPackageVersion([])).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "wi-ver-"));
    const missing = join(dir, "package.json");
    expect(readPackageVersion([missing])).toBeNull();
    writeFileSync(missing, '{ "name": "no-version" }');
    expect(readPackageVersion([missing])).toBeNull();
    writeFileSync(missing, "{ not json");
    expect(readPackageVersion([missing])).toBeNull();
  });

  test("resolveDeployVars stamps LXK_ENV, LXK_PUBLIC_URL, and LXK_VERSION", () => {
    expect(
      resolveDeployVars({
        version: "2026.6.2",
        publicUrl: "https://lexa.example.com",
      }),
    ).toEqual({
      LXK_ENV: "production",
      LXK_PUBLIC_URL: "https://lexa.example.com",
      LXK_VERSION: "2026.6.2",
    });
  });

  test("resolveDeployVars stamps the workers.dev public URL too", () => {
    expect(
      resolveDeployVars({ version: "2026.6.2", publicUrl: "https://lexa.acct.workers.dev" }),
    ).toEqual({
      LXK_ENV: "production",
      LXK_PUBLIC_URL: "https://lexa.acct.workers.dev",
      LXK_VERSION: "2026.6.2",
    });
  });

  test("resolveDeployVars omits a key only when genuinely unknown", () => {
    expect(resolveDeployVars({ version: null, publicUrl: "" })).toEqual({
      LXK_ENV: "production",
    });
  });

  test("main emits vars via resolveDeployVars + readDeployVersion(DIR)", () => {
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    // main() stamps the repo version into the buildDeployConfig input;
    // buildDeployConfig turns it into vars via resolveDeployVars.
    expect(src).toContain("version: readDeployVersion(DIR)");
    expect(src).toContain("vars: resolveDeployVars(");
  });
});

describe("source order — account resolves before any resource is created", () => {
  test("the resolveAccountOrDie call precedes the ensureD1 call in main", () => {
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    const resolveIdx = src.indexOf("account = resolveAccountOrDie(");
    const ensureIdx = src.indexOf("await ensureD1(");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeLessThan(ensureIdx);
  });

  test("main no longer emits DO/AI blocks: no resolveDurableObjects/resolveAiBinding in the generated config", () => {
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    expect(src).not.toContain("resolveDurableObjects");
    expect(src).not.toContain("resolveAiBinding");
    expect(src).not.toContain("resolveServiceBindings");
    expect(src).not.toContain("durable_objects,");
  });

  test("buildDeployConfig emits no DO migrations for a fresh install", () => {
    const config = buildDeployConfig({
      workerName: "lexa",
      d1Name: "lexa",
      account: "acct_123",
      d1Id: "d1-abc",
      r2Name: "lexa-blobs",
      kvId: "kv-abc",
      publicUrl: "https://lexa.example.workers.dev",
      version: "2026.9.0",
      manifest: { main: "index.js", assets: { directory: "../client" } },
      rootConfig: {
        compatibility_date: "2026-08-01",
        triggers: { crons: ["*/15 * * * *"] },
      },
      priorConfig: null,
    });
    expect(config.migrations).toBeUndefined();
    expect(config.durable_objects).toBeUndefined();
    expect(config.triggers).toEqual({ crons: ["*/15 * * * *"] });
  });

  test("buildDeployConfig appends the delete-class migration for a DO-era prior deploy", () => {
    const config = buildDeployConfig({
      workerName: "lexa",
      d1Name: "lexa",
      account: "acct_123",
      d1Id: "d1-abc",
      r2Name: "lexa-blobs",
      kvId: "kv-abc",
      publicUrl: "https://lexa.example.workers.dev",
      version: "2026.9.0",
      manifest: { main: "index.js", assets: { directory: "../client" } },
      rootConfig: {
        compatibility_date: "2026-08-01",
        triggers: { crons: ["*/15 * * * *"] },
      },
      priorConfig: {
        durable_objects: {
          bindings: [
            { name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] }],
      },
    });
    expect(config.durable_objects).toBeUndefined();
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
    ]);
    expect(config.triggers).toEqual({ crons: ["*/15 * * * *"] });
  });

  test("main emits observability: resolveObservability(rootConfig) into the generated config", () => {
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain("observability: resolveObservability(rootConfig)");
  });

  test("main carries root's scheduled tick (prune + backup retention) into the generated config", () => {
    const ROOT = fileURLToPath(new URL("..", import.meta.url));
    expect(readRootWranglerConfig(ROOT).triggers).toEqual({ crons: ["*/15 * * * *"] });
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain("...(rootConfig.triggers !== undefined ? { triggers: rootConfig.triggers } : {})");
  });

  test("main emits the ASSETS binding on the static-assets directory", () => {
    const src = readFileSync(
      new URL("./lib/cf-deploy.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain('assets: { directory: "./assets", binding: "ASSETS" }');
  });
});

describe("installer wrangler-token extraction (banner-faking fixture)", () => {
  const LIB = fileURLToPath(new URL("./install-lib.sh", import.meta.url));
  const runExtract = (raw: string) =>
    spawnSync("bash", ["-c", `source ${JSON.stringify(LIB)}; _cf_extract_token`], {
      input: raw,
      encoding: "utf-8",
    });

  test("extracts only the cfoat token from a banner-emitting stream", () => {
    // wrangler 4.147.0 prints this banner on STDOUT before the token.
    const banner =
      "⛅️ wrangler 4.147.0 (update available 4.149.0)\n───────────────────────────\ncfoat_AbC-123_xyz.token\n";
    expect((runExtract(banner).stdout ?? "").trim()).toBe("cfoat_AbC-123_xyz.token");
  });

  test("falls back to the last bare-token line when there is no cfoat prefix", () => {
    const banner =
      "⛅️ wrangler 4.147.0 (update available 4.149.0)\n───────────\nplain-oauth_token.v1\n";
    expect((runExtract(banner).stdout ?? "").trim()).toBe("plain-oauth_token.v1");
  });

  test("tolerates CRLF line endings on the fallback token line", () => {
    const banner =
      "⛅️ wrangler 4.147.0 (update available 4.149.0)\r\n───────────\r\nplain-tok\r\n";
    expect((runExtract(banner).stdout ?? "").trim()).toBe("plain-tok");
  });

  test("prints nothing and exits non-zero when no token line is present", () => {
    const res = runExtract("⛅️ wrangler 4.147.0 (update available 4.149.0)\n───────────\n");
    expect(res.status).not.toBe(0);
    expect((res.stdout ?? "").trim()).toBe("");
  });
});

describe("importable core", () => {
  test("importing cf-deploy does not execute main (no deploy side effects)", () => {
    const core = fileURLToPath(new URL("./lib/cf-deploy.ts", import.meta.url));
    const res = spawnSync(
      "bun",
      [
        "-e",
        `await import(${JSON.stringify(core)}); console.log("CORE_IMPORT_OK");`,
      ],
      {
        encoding: "utf-8",
        // No credentials: if main ran it would die on the missing token and
        // exit 1 before printing the marker.
        env: {
          ...process.env,
          CF_API_TOKEN: "",
          CLOUDFLARE_API_TOKEN: "",
          CLOUDFLARE_ACCOUNT_ID: "",
        },
      },
    );
    expect(res.stderr).not.toContain("no Cloudflare credentials");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("CORE_IMPORT_OK");
  });

  test("workers-install.ts is a thin wrapper that runs main only as the entry script", () => {
    const src = readFileSync(
      new URL("./workers-install.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain('import { main } from "./lib/cf-deploy";');
    expect(src).toContain("if (import.meta.main) {");
    expect(src).toContain("await main();");
    // The wrapper must not re-declare provisioning logic.
    expect(src).not.toContain("ensureD1");
  });
});
