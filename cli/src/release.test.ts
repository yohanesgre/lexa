// cli/release.ts: web-app release resolution + checksum verification.
// Fixture-driven — a fake ReleaseFetcher replaces the network, so these tests
// never touch GitHub (install-lib.sh's fetch_release is the ported source).
// cli/version.ts: deployed web-app version marker helpers.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  LEXA_REPO,
  ReleaseError,
  isWebReleaseTag,
  parseChecksums,
  releaseForTag,
  releasesListUrl,
  resolveWorkersRelease,
  selectLatestWebTag,
  sha256Hex,
  verifyTarballChecksum,
  workersTarballName,
  type ReleaseFetcher,
} from "./release";
import {
  readDeployedVersion,
  resolveLatestVersion,
  sameVersion,
  webTagToVersion,
} from "./version";

const TARBALL = workersTarballName("v2026.2.9");
const BYTES = new TextEncoder().encode("lexa-workers tarball fixture bytes\n");

function tarballSha(): string {
  return createHash("sha256").update(BYTES).digest("hex");
}

function checksumsLine(sha: string, name = TARBALL, marker = "  "): string {
  return `${sha}${marker}${name}\n`;
}

function fixtureFetcher(releases: Array<{ tag_name: string }>, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: ReleaseFetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(releases), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

describe("tag anchoring", () => {
  it("isWebReleaseTag anchors on v followed by a digit; selectLatestWebTag skips cli-v* tags", () => {
    expect(isWebReleaseTag("v2026.2.9")).toBe(true);
    expect(isWebReleaseTag("v0.1.0")).toBe(true);
    expect(isWebReleaseTag("v2")).toBe(true);
    expect(isWebReleaseTag("cli-v2026.2.9")).toBe(false);
    expect(isWebReleaseTag("vNext")).toBe(false);
    expect(isWebReleaseTag("v")).toBe(false);
    expect(isWebReleaseTag("main")).toBe(false);
    expect(isWebReleaseTag("releases/latest")).toBe(false);

    expect(
      selectLatestWebTag([
        { tag_name: "cli-v2026.9.0" },
        { tag_name: "v2026.2.9" },
        { tag_name: "v2026.2.8" },
      ]),
    ).toBe("v2026.2.9");
    expect(selectLatestWebTag([{ tag_name: "cli-v1.0.0" }, { tag_name: "main" }])).toBeNull();
    expect(selectLatestWebTag([])).toBeNull();
  });
});

describe("resolveWorkersRelease", () => {
  it("resolves the newest web-app release with tarball/checksums URLs, never /releases/latest", async () => {
    const { fetcher, calls } = fixtureFetcher([
      { tag_name: "cli-v2026.9.0" },
      { tag_name: "v2026.2.9" },
      { tag_name: "v2026.2.8" },
    ]);
    const release = await resolveWorkersRelease(fetcher);
    expect(release).toEqual(releaseForTag("v2026.2.9", LEXA_REPO));
    expect(release.tag).toBe("v2026.2.9");
    expect(release.tarballUrl).toBe(
      `https://github.com/${LEXA_REPO}/releases/download/v2026.2.9/${TARBALL}`
    );
    expect(release.checksumsUrl).toBe(
      `https://github.com/${LEXA_REPO}/releases/download/v2026.2.9/checksums.txt`
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(releasesListUrl());
    expect(calls[0]!.url).not.toContain("/releases/latest");
  });

  it("fails with no-release, a non-ok response, or a rejected fetch", async () => {
    const noRelease = await resolveWorkersRelease(fixtureFetcher([{ tag_name: "cli-v1.0.0" }]).fetcher).catch((e: unknown) => e);
    expect(noRelease).toBeInstanceOf(ReleaseError);
    expect((noRelease as ReleaseError).reason).toBe("no-release");

    const denial = await resolveWorkersRelease(fixtureFetcher([], 403).fetcher).catch((e: unknown) => e);
    expect(denial).toBeInstanceOf(ReleaseError);
    expect((denial as ReleaseError).reason).toBe("resolve-failed");
    expect((denial as ReleaseError).status).toBe(403);

    const offlineFetcher: ReleaseFetcher = async () => {
      throw new Error("offline");
    };
    const offline = await resolveWorkersRelease(offlineFetcher).catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(ReleaseError);
    expect((offline as ReleaseError).reason).toBe("resolve-failed");
    expect((offline as ReleaseError).detail).toBe("offline");
  });
});

describe("checksums", () => {
  it("parseChecksums maps basenames (binary markers, nested paths); verify accepts a matching sha256", () => {
    const text = [
      `${"a".repeat(64)}  other-file.tar.gz`,
      `${"b".repeat(64)} *${TARBALL}`,
      `${"c".repeat(64)}  ./nested/third-file.tar.gz`,
      "",
    ].join("\n");
    const sums = parseChecksums(text);
    expect(sums.get(TARBALL)).toBe("b".repeat(64));
    expect(sums.get("other-file.tar.gz")).toBe("a".repeat(64));
    expect(sums.get("third-file.tar.gz")).toBe("c".repeat(64));

    expect(() => verifyTarballChecksum(BYTES, checksumsLine(tarballSha()), TARBALL)).not.toThrow();
    expect(sha256Hex(BYTES)).toBe(tarballSha());
    expect(() =>
      verifyTarballChecksum(BYTES, checksumsLine(tarballSha(), `./${TARBALL}`, " *"), TARBALL),
    ).not.toThrow();
  });

  it("fails checksum-mismatch on a wrong hash and checksum-missing with no entry", () => {
    const mismatch = (() => {
      try {
        verifyTarballChecksum(BYTES, checksumsLine("0".repeat(64)), TARBALL);
      } catch (e) {
        return e;
      }
    })();
    expect(mismatch).toBeInstanceOf(ReleaseError);
    expect((mismatch as ReleaseError).reason).toBe("checksum-mismatch");
    expect((mismatch as ReleaseError).expected).toBe("0".repeat(64));
    expect((mismatch as ReleaseError).actual).toBe(tarballSha());

    const missing = (() => {
      try {
        verifyTarballChecksum(BYTES, checksumsLine(tarballSha(), "some-other.tar.gz"), TARBALL);
      } catch (e) {
        return e;
      }
    })();
    expect(missing).toBeInstanceOf(ReleaseError);
    expect((missing as ReleaseError).reason).toBe("checksum-missing");
    expect((missing as ReleaseError).tarballName).toBe(TARBALL);
  });
});

function versionFixtureFetcher(tags: string[]): ReleaseFetcher {
  return async () =>
    new Response(JSON.stringify(tags.map((tag_name) => ({ tag_name }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

describe("readDeployedVersion", () => {
  it("reads vars.LXK_VERSION; null without/with a malformed marker (pre-LX-36 deploy)", () => {
    expect(readDeployedVersion({ vars: { LXK_VERSION: "2026.6.2" } })).toBe("2026.6.2");
    expect(readDeployedVersion({ vars: { LXK_PUBLIC_URL: "https://x.test" } })).toBeNull();
    expect(readDeployedVersion({ vars: {} })).toBeNull();
    expect(readDeployedVersion({})).toBeNull();
    expect(readDeployedVersion(null)).toBeNull();
    expect(readDeployedVersion(undefined)).toBeNull();
    expect(readDeployedVersion({ vars: { LXK_VERSION: "" } })).toBeNull();
    expect(readDeployedVersion({ vars: { LXK_VERSION: 42 } } as never)).toBeNull();
    expect(readDeployedVersion({ vars: "nope" } as never)).toBeNull();
  });
});

describe("version helpers", () => {
  it("webTagToVersion strips the v prefix; resolveLatestVersion resolves the newest v[0-9] tag", async () => {
    expect(webTagToVersion("v2026.6.2")).toBe("2026.6.2");
    expect(webTagToVersion("2026.6.2")).toBe("2026.6.2");
    expect(await resolveLatestVersion(versionFixtureFetcher(["cli-v2026.9.0", "v2026.6.2", "v2026.6.1"]))).toBe("2026.6.2");
  });

  it("sameVersion is true only when both versions are known and equal", () => {
    expect(sameVersion("2026.6.2", "2026.6.2")).toBe(true);
    expect(sameVersion("2026.6.1", "2026.6.2")).toBe(false);
    expect(sameVersion(null, "2026.6.2")).toBe(false);
    expect(sameVersion(undefined, "2026.6.2")).toBe(false);
    expect(sameVersion("", "2026.6.2")).toBe(false);
    expect(sameVersion("2026.6.2", null)).toBe(false);
  });
});
