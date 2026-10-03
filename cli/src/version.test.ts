// cli/version.ts: deployed web-app version marker helpers. The release
// resolver is exercised with an injected fetcher, so these tests never touch
// the network.
import { describe, expect, it } from "vitest";
import type { ReleaseFetcher } from "./release";
import {
  compareVersions,
  readDeployedVersion,
  resolveLatestVersion,
  sameVersion,
  webTagToVersion,
} from "./version";

function fixtureFetcher(tags: string[]): ReleaseFetcher {
  return async () =>
    new Response(JSON.stringify(tags.map((tag_name) => ({ tag_name }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

describe("readDeployedVersion", () => {
  it("reads vars.LXK_VERSION from a resolved deploy config", () => {
    expect(
      readDeployedVersion({ vars: { LXK_VERSION: "2026.6.2" } }),
    ).toBe("2026.6.2");
  });

  it("returns null when the marker is missing (pre-LX-36 deploy)", () => {
    expect(readDeployedVersion({ vars: { LXK_PUBLIC_URL: "https://x.test" } })).toBeNull();
    expect(readDeployedVersion({ vars: {} })).toBeNull();
    expect(readDeployedVersion({})).toBeNull();
    expect(readDeployedVersion(null)).toBeNull();
    expect(readDeployedVersion(undefined)).toBeNull();
  });

  it("returns null for a malformed config or empty/non-string marker", () => {
    expect(readDeployedVersion(null)).toBeNull();
    expect(
      readDeployedVersion({ vars: { LXK_VERSION: "" } }),
    ).toBeNull();
    expect(
      readDeployedVersion({ vars: { LXK_VERSION: 42 } } as never),
    ).toBeNull();
    expect(readDeployedVersion({ vars: "nope" } as never)).toBeNull();
  });
});

describe("compareVersions (re-export)", () => {
  it("orders older, newer, and equal versions", () => {
    expect(compareVersions("2026.6.1", "2026.6.2")).toBeLessThan(0);
    expect(compareVersions("2026.6.3", "2026.6.2")).toBeGreaterThan(0);
    expect(compareVersions("2026.6.2", "2026.6.2")).toBe(0);
  });
});

describe("webTagToVersion", () => {
  it("strips the release tag's v prefix", () => {
    expect(webTagToVersion("v2026.6.2")).toBe("2026.6.2");
    expect(webTagToVersion("2026.6.2")).toBe("2026.6.2");
  });
});

describe("resolveLatestVersion", () => {
  it("resolves the newest v[0-9] release tag to its version", async () => {
    const fetcher = fixtureFetcher(["cli-v2026.9.0", "v2026.6.2", "v2026.6.1"]);
    expect(await resolveLatestVersion(fetcher)).toBe("2026.6.2");
  });
});

describe("sameVersion", () => {
  it("is true only when both versions are known and equal (refusal input)", () => {
    expect(sameVersion("2026.6.2", "2026.6.2")).toBe(true);
    expect(sameVersion("2026.6.1", "2026.6.2")).toBe(false);
    expect(sameVersion("2026.6.2", "2026.6.1")).toBe(false);
  });

  it("is false when the current version is unknown — the caller warns instead", () => {
    expect(sameVersion(null, "2026.6.2")).toBe(false);
    expect(sameVersion(undefined, "2026.6.2")).toBe(false);
    expect(sameVersion("", "2026.6.2")).toBe(false);
    expect(sameVersion("2026.6.2", null)).toBe(false);
  });
});
