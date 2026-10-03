// cli/release.ts: web-app release resolution + checksum verification.
// Fixture-driven — a fake ReleaseFetcher replaces the network, so these tests
// never touch GitHub (install-lib.sh's fetch_release is the ported source).
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

describe("isWebReleaseTag", () => {
  it("anchors on v followed by a digit", () => {
    expect(isWebReleaseTag("v2026.2.9")).toBe(true);
    expect(isWebReleaseTag("v0.1.0")).toBe(true);
    expect(isWebReleaseTag("v2")).toBe(true);
  });

  it("excludes cli-v* and non-release tags", () => {
    expect(isWebReleaseTag("cli-v2026.2.9")).toBe(false);
    expect(isWebReleaseTag("vNext")).toBe(false);
    expect(isWebReleaseTag("v")).toBe(false);
    expect(isWebReleaseTag("main")).toBe(false);
    expect(isWebReleaseTag("releases/latest")).toBe(false);
  });
});

describe("selectLatestWebTag", () => {
  it("takes the first v[0-9] tag, skipping cli-v* entries", () => {
    expect(
      selectLatestWebTag([
        { tag_name: "cli-v2026.9.0" },
        { tag_name: "v2026.2.9" },
        { tag_name: "v2026.2.8" },
      ]),
    ).toBe("v2026.2.9");
  });

  it("returns null when no web-app tag exists", () => {
    expect(selectLatestWebTag([{ tag_name: "cli-v1.0.0" }, { tag_name: "main" }])).toBeNull();
    expect(selectLatestWebTag([])).toBeNull();
  });
});

describe("releaseForTag", () => {
  it("builds the workers tarball + checksums URLs", () => {
    expect(releaseForTag("v2026.2.9", LEXA_REPO)).toEqual({
      tag: "v2026.2.9",
      tarballUrl: `https://github.com/${LEXA_REPO}/releases/download/v2026.2.9/${TARBALL}`,
      checksumsUrl: `https://github.com/${LEXA_REPO}/releases/download/v2026.2.9/checksums.txt`,
    });
  });
});

describe("resolveWorkersRelease", () => {
  it("resolves the newest web-app release, never /releases/latest", async () => {
    const { fetcher, calls } = fixtureFetcher([
      { tag_name: "cli-v2026.9.0" },
      { tag_name: "v2026.2.9" },
      { tag_name: "v2026.2.8" },
    ]);
    const release = await resolveWorkersRelease(fetcher);

    expect(release.tag).toBe("v2026.2.9");
    expect(release.tarballUrl).toContain(`/download/v2026.2.9/${TARBALL}`);
    expect(release.checksumsUrl).toContain("/download/v2026.2.9/checksums.txt");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(releasesListUrl());
    expect(calls[0]!.url).not.toContain("/releases/latest");
  });

  it("throws no-release when the list has no v[0-9] tag", async () => {
    const { fetcher } = fixtureFetcher([{ tag_name: "cli-v1.0.0" }]);
    const err = await resolveWorkersRelease(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).reason).toBe("no-release");
  });

  it("throws resolve-failed on a non-ok response", async () => {
    const { fetcher } = fixtureFetcher([], 403);
    const err = await resolveWorkersRelease(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).reason).toBe("resolve-failed");
    expect((err as ReleaseError).status).toBe(403);
  });

  it("throws resolve-failed when the fetcher rejects", async () => {
    const fetcher: ReleaseFetcher = async () => {
      throw new Error("offline");
    };
    const err = await resolveWorkersRelease(fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).reason).toBe("resolve-failed");
    expect((err as ReleaseError).detail).toBe("offline");
  });
});

describe("parseChecksums", () => {
  it("parses sha256sum lines, including binary-mode markers and paths", () => {
    const text = [
      `${"a".repeat(64)}  other-file.tar.gz`,
      `${"b".repeat(64)} *${TARBALL}`,
      `${"c".repeat(64)}  ./nested/third-file.tar.gz`,
      "",
    ].join("\n");
    const sums = parseChecksums(text);
    expect(sums.get(TARBALL)).toBe("b".repeat(64));
    expect(sums.get("other-file.tar.gz")).toBe("a".repeat(64));
    // basename strips a `./nested/` path prefix
    expect(sums.get("third-file.tar.gz")).toBe("c".repeat(64));
  });
});

describe("verifyTarballChecksum", () => {
  it("accepts a matching sha256", () => {
    expect(() => verifyTarballChecksum(BYTES, checksumsLine(tarballSha()), TARBALL)).not.toThrow();
    expect(sha256Hex(BYTES)).toBe(tarballSha());
  });

  it("accepts a binary-mode marker and a path-prefixed filename", () => {
    expect(() =>
      verifyTarballChecksum(BYTES, checksumsLine(tarballSha(), `./${TARBALL}`, " *"), TARBALL),
    ).not.toThrow();
  });

  it("throws checksum-mismatch on a wrong hash", () => {
    const err = (() => {
      try {
        verifyTarballChecksum(BYTES, checksumsLine("0".repeat(64)), TARBALL);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).reason).toBe("checksum-mismatch");
    expect((err as ReleaseError).expected).toBe("0".repeat(64));
    expect((err as ReleaseError).actual).toBe(tarballSha());
  });

  it("throws checksum-missing when checksums.txt has no entry for the tarball", () => {
    const err = (() => {
      try {
        verifyTarballChecksum(BYTES, checksumsLine(tarballSha(), "some-other.tar.gz"), TARBALL);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).reason).toBe("checksum-missing");
    expect((err as ReleaseError).tarballName).toBe(TARBALL);
  });
});
