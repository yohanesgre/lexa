// Unit tests for the pure D1 selector in scripts/workers-install.ts.
//
// workers-install.ts guards its runtime side effects behind `import.meta.main`,
// so importing it here is inert. Run with `bun test scripts/workers-install.test.ts`
// (invoked from scripts/test-install.sh, the CI `install-script` job).
import { describe, expect, test } from "bun:test";
import { d1AmbiguousMessage, resolveNames, selectD1, type D1Row } from "./workers-install";

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
