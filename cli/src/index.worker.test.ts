// cli/worker.ts — `lx worker upgrade` dispatch + target resolution. The
// subprocess tests exercise the REAL entry point (mirrors index.entry.test.ts);
// the pure tests cover config discovery/selection directly.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolationDirs, freshLexaDir, runCli } from "./test-utils";
import { discoverWorkerDeploys, parseWorkerConfigText, selectWorkerDeploy } from "./worker";

const tmpRoots: string[] = [];

afterAll(() => {
  cleanupIsolationDirs();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots.length = 0;
});

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-worker-"));
  tmpRoots.push(d);
  return d;
}

function writeDeploy(
  root: string,
  flavor: string,
  cfg: { name: string; accountId?: string; publicUrl?: string; version?: string },
): void {
  const dir = join(root, `deploy-${flavor}`);
  mkdirSync(dir, { recursive: true });
  const config: Record<string, unknown> = {
    name: cfg.name,
    account_id: cfg.accountId ?? "acct_123",
    vars: {
      ...(cfg.publicUrl ? { LXK_PUBLIC_URL: cfg.publicUrl } : {}),
      ...(cfg.version ? { LXK_VERSION: cfg.version } : {}),
    },
  };
  writeFileSync(join(dir, `wrangler.${flavor}.json`), JSON.stringify(config, null, 2) + "\n");
}

// A saved login for `url`, landing in its normalized group dir.
function writeLogin(lexaDir: string, url: string): void {
  const host = new URL(url).hostname;
  mkdirSync(join(lexaDir, host), { recursive: true });
  writeFileSync(join(lexaDir, host, "config.json"), JSON.stringify({ url, apiKey: "lxk_test" }));
}

describe("worker dispatch + help", () => {
  it("routes to worker group help with no subcommand and exits 0", async () => {
    const r = await runCli(["worker"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("worker upgrade");
  });

  it("rejects an unknown worker subcommand with usage + exit 1", async () => {
    const r = await runCli(["worker", "bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown: worker bogus");
    expect(r.stdout).toContain("worker upgrade");
  });

  it("lists worker upgrade in the top-level help", async () => {
    const r = await runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("worker upgrade");
  });

  it("refuses outside a cf-workers custody dir with the cd guidance", async () => {
    const root = makeRoot();
    const r = await runCli(["worker", "upgrade", "--dir", root], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No Cloudflare Workers deploy found");
    expect(r.stderr).toContain("cf-workers/");
  });

  it("rejects a bare --dir flag with usage", async () => {
    const r = await runCli(["worker", "upgrade", "--dir"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx worker upgrade");
  });
});

describe("worker upgrade target resolution", () => {
  it("resolves a single deploy and prints the plan (dry run)", async () => {
    const root = makeRoot();
    writeDeploy(root, "lexa", { name: "lexa", accountId: "acct_single", publicUrl: "https://lexa.example.com", version: "2026.6.2" });
    const r = await runCli(["worker", "upgrade", "--dir", root, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Worker:      lexa");
    expect(r.stdout).toContain("Account:     acct_single");
    expect(r.stdout).toContain("Deploy dir:");
    expect(r.stdout).toContain("Version:     2026.6.2");
    expect(r.stdout).toContain("Dry run — no changes made.");
  });

  it("fails offline without credentials instead of stubbing the update", async () => {
    const root = makeRoot();
    writeDeploy(root, "lexa", { name: "lexa" });
    const r = await runCli(["worker", "upgrade", "--dir", root], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Worker:      lexa");
    expect(r.stderr).toContain("could not resolve the release");
  });

  it("refuses several deploys without --worker and lists them", async () => {
    const root = makeRoot();
    writeDeploy(root, "alpha", { name: "alpha" });
    writeDeploy(root, "beta", { name: "beta" });
    const r = await runCli(["worker", "upgrade", "--dir", root, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Multiple deploys");
    expect(r.stderr).toContain("alpha");
    expect(r.stderr).toContain("beta");
    expect(r.stderr).toContain("--worker");
  });

  it("selects among several deploys with --worker", async () => {
    const root = makeRoot();
    writeDeploy(root, "alpha", { name: "alpha-worker" });
    writeDeploy(root, "beta", { name: "beta-worker" });
    const r = await runCli(["worker", "upgrade", "--dir", root, "--worker", "beta", "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Worker:      beta-worker");
  });

  it("refuses an unknown --worker with the available list", async () => {
    const root = makeRoot();
    writeDeploy(root, "alpha", { name: "alpha" });
    writeDeploy(root, "beta", { name: "beta" });
    const r = await runCli(["worker", "upgrade", "--dir", root, "--worker", "nope", "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No deploy matches --worker 'nope'");
    expect(r.stderr).toContain("alpha, beta");
  });

  it("breaks a several-deploy tie with the saved login host ↔ LXK_PUBLIC_URL match", async () => {
    const root = makeRoot();
    writeDeploy(root, "alpha", { name: "alpha-worker", publicUrl: "https://alpha.example.com" });
    writeDeploy(root, "beta", { name: "beta-worker", publicUrl: "https://lexa.example.com" });
    const lexaDir = freshLexaDir();
    writeLogin(lexaDir, "https://lexa.example.com");
    const r = await runCli(["worker", "upgrade", "--dir", root, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir, LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Worker:      beta-worker");
  });

  it("refuses when the resolved deploy does not match the saved login server", async () => {
    const root = makeRoot();
    writeDeploy(root, "lexa", { name: "lexa", publicUrl: "https://lexa.example.com" });
    const lexaDir = freshLexaDir();
    writeLogin(lexaDir, "https://other.example.com");
    const r = await runCli(["worker", "upgrade", "--dir", root, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir, LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("you are logged in to");
    expect(r.stderr).toContain("other.example.com");
  });
});

describe("worker config parsing + selection (pure)", () => {
  it("parses name/account/public URL/version and rejects non-configs", () => {
    const parsed = parseWorkerConfigText(JSON.stringify({ name: "lexa", account_id: "a1", vars: { LXK_PUBLIC_URL: "https://x.test", LXK_VERSION: "1.2.3" } }));
    expect(parsed).toEqual({ name: "lexa", accountId: "a1", publicUrl: "https://x.test", version: "1.2.3" });
    expect(parseWorkerConfigText("not json")).toBeNull();
    expect(parseWorkerConfigText(JSON.stringify({ account_id: "a1" }))).toBeNull();
  });

  it("discovers deploy-*/wrangler.*.json and skips dirs without a config", () => {
    const root = makeRoot();
    writeDeploy(root, "beta", { name: "beta" });
    writeDeploy(root, "alpha", { name: "alpha" });
    mkdirSync(join(root, "deploy-empty"), { recursive: true });
    const configs = discoverWorkerDeploys(root);
    expect(configs.map((c) => c.flavor)).toEqual(["alpha", "beta"]);
    expect(configs[0]!.workerName).toBe("alpha");
  });

  it("never discovers a deploy-<flavor>.bak backup as a deploy (second-run simulation)", () => {
    const root = makeRoot();
    writeDeploy(root, "lexa", { name: "lexa", accountId: "acct_live", version: "2.0.0" });
    // The backup sits beside the live dir with the same config name.
    const bak = join(root, "deploy-lexa.bak");
    mkdirSync(bak, { recursive: true });
    writeFileSync(
      join(bak, "wrangler.lexa.json"),
      JSON.stringify({ name: "lexa", account_id: "acct_stale", vars: { LXK_VERSION: "1.0.0" } }, null, 2) + "\n",
    );

    const configs = discoverWorkerDeploys(root);
    expect(configs.map((c) => c.flavor)).toEqual(["lexa"]);
    expect(configs[0]!.accountId).toBe("acct_live");

    // A second run (backup present) must target the live deploy, never the .bak.
    const picked = selectWorkerDeploy(configs, { worker: "lexa" });
    expect(picked.kind).toBe("resolved");
    if (picked.kind === "resolved") {
      expect(picked.config.flavor).toBe("lexa");
      expect(picked.config.accountId).toBe("acct_live");
    }
  });

  it("selectWorkerDeploy defensively drops .bak entries", () => {
    const live = { flavor: "lexa", dir: "", configPath: "", workerName: "lexa", accountId: "acct_live", publicUrl: "", version: "" };
    const stale = { flavor: "lexa.bak", dir: "", configPath: "", workerName: "lexa", accountId: "acct_stale", publicUrl: "", version: "" };
    expect(selectWorkerDeploy([stale], {})).toEqual({ kind: "none" });
    const picked = selectWorkerDeploy([live, stale], {});
    expect(picked.kind).toBe("resolved");
    if (picked.kind === "resolved") expect(picked.config.accountId).toBe("acct_live");
  });

  it("selectWorkerDeploy: worker-not-found, single, and login-host tie-break", () => {
    const single = [{ flavor: "lexa", dir: "", configPath: "", workerName: "lexa", accountId: "", publicUrl: "", version: "" }];
    expect(selectWorkerDeploy(single, {}).kind).toBe("resolved");
    const many = [
      { flavor: "alpha", dir: "", configPath: "", workerName: "alpha", accountId: "", publicUrl: "https://alpha.test", version: "" },
      { flavor: "beta", dir: "", configPath: "", workerName: "beta", accountId: "", publicUrl: "https://beta.test", version: "" },
    ];
    expect(selectWorkerDeploy(many, {})).toEqual({ kind: "ambiguous", available: ["alpha", "beta"] });
    expect(selectWorkerDeploy(many, { worker: "nope" })).toEqual({ kind: "worker-not-found", worker: "nope", available: ["alpha", "beta"] });
    const picked = selectWorkerDeploy(many, { loginHost: "beta.test" });
    expect(picked.kind).toBe("resolved");
    if (picked.kind === "resolved") expect(picked.config.flavor).toBe("beta");
  });
});
