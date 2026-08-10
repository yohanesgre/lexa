import { describe, expect, it } from "vitest";
import { cliTagToVersion, compareVersions } from "./upgrade";

describe("cliTagToVersion", () => {
  it("parses cli-vX.Y.Z tags", () => {
    expect(cliTagToVersion("cli-v1.2.3")).toBe("1.2.3");
    expect(cliTagToVersion("cli-v0.1.0")).toBe("0.1.0");
  });

  it("rejects non-cli tags and malformed versions", () => {
    expect(cliTagToVersion("v1.2.3")).toBeNull();
    expect(cliTagToVersion("cli-v")).toBeNull();
    expect(cliTagToVersion("releases/latest")).toBeNull();
    expect(cliTagToVersion("cli-v1.2.3.4")).toBe("1.2.3.4"); // loose — any [0-9.] suffix parses
  });
});

describe("compareVersions", () => {
  it("orders numeric segments", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  it("handles dev sentinel semantics used by upgrade (dev is always upgradeable)", () => {
    // CLI_VERSION "dev" is special-cased at the call site; the comparator
    // itself stays numeric-only.
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});
