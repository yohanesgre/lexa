// Unit tests for the pure D1 selector in scripts/workers-install.ts.
//
// workers-install.ts guards its runtime side effects behind `import.meta.main`,
// so importing it here is inert. Run with `bun test scripts/workers-install.test.ts`
// (invoked from scripts/test-install.sh, the CI `install-script` job).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountAmbiguousMessage,
  accountStaleMessage,
  d1AmbiguousMessage,
  readPriorAccount,
  readRootWranglerConfig,
  resolveAccountOrDie,
  resolveNames,
  resolveObservability,
  selectAccount,
  selectD1,
  type AccountRow,
  type D1Row,
} from "./workers-install";

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

describe("root wrangler observability", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  test("root wrangler.jsonc pins the Cloudflare default observability block", () => {
    expect(readRootWranglerConfig(ROOT).observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: false,
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
    const generated = resolveObservability(root);
    if (!root.observability) throw new Error("root wrangler.jsonc has no observability");
    expect(generated).toEqual(root.observability);
    expect(generated.logs).toMatchObject({
      enabled: true,
      head_sampling_rate: 1,
      invocation_logs: true,
      persist: true,
    });
    expect(generated.traces).toMatchObject({
      enabled: true,
      head_sampling_rate: 1,
      persist: true,
    });
    expect(generated.issues).toMatchObject({ enabled: true });
    expect(generated.head_sampling_rate).toBe(1);
  });

  test("a root config without observability falls back to bare enable", () => {
    const dir = mkdtempSync(join(tmpdir(), "wi-obs-"));
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "name": "lexa" }\n');
    expect(resolveObservability(readRootWranglerConfig(dir))).toEqual({
      enabled: true,
    });
  });
});

describe("source order — account resolves before any resource is created", () => {
  test("the resolveAccountOrDie call precedes the ensureD1 call in main", () => {
    const src = readFileSync(
      new URL("./workers-install.ts", import.meta.url),
      "utf-8",
    );
    const resolveIdx = src.indexOf("account = resolveAccountOrDie(");
    const ensureIdx = src.indexOf("await ensureD1(");
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeLessThan(ensureIdx);
  });
});
