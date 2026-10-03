// Web-app release resolution — the `lx worker upgrade` counterpart to
// upgrade.ts's CLI self-update. Web app releases are published on `vX.Y.Z`
// tags (the image + `lexa-workers-<tag>.tar.gz` asset); CLI releases use
// `cli-vX.Y.Z`. So resolution lists releases and anchors on `v[0-9]` — NEVER
// `releases/latest`, which may point at a CLI release published afterwards.
//
// Mirrors scripts/install-lib.sh `fetch_release` (tag selection + checksum
// verification) as a pure, fetch-injectable module.
import { Data } from "effect";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export const LEXA_REPO = "yohanesgre/lexa";

// Newest-first release list. `per_page=30` mirrors install-lib.sh (enough to
// cover recent web-app + CLI tags without paginating).
export function releasesListUrl(repo: string = LEXA_REPO): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=30`;
}

export interface ReleaseInfo {
  tag: string;
  tarballUrl: string;
  checksumsUrl: string;
}

export type ReleaseErrorReason =
  | "resolve-failed"
  | "no-release"
  | "checksum-missing"
  | "checksum-mismatch";

export class ReleaseError extends Data.TaggedError("ReleaseError")<{
  reason: ReleaseErrorReason;
  status?: number | undefined;
  detail?: string | undefined;
  tarballName?: string | undefined;
  expected?: string | undefined;
  actual?: string | undefined;
}> {
  override get message(): string {
    switch (this.reason) {
      case "resolve-failed":
        return `could not resolve the latest release${this.status !== undefined ? ` (HTTP ${this.status})` : ""}${this.detail ? `: ${this.detail}` : ""}`;
      case "no-release":
        return "no web-app release found (no v[0-9] tag in the release list)";
      case "checksum-missing":
        return `checksums.txt has no entry for ${this.tarballName}`;
      case "checksum-mismatch":
        return `checksum mismatch for ${this.tarballName}: expected ${this.expected}, got ${this.actual}`;
    }
  }
}

// The web-app tag anchor — `v` followed by a digit. `cli-v...` never matches.
export function isWebReleaseTag(tag: string): boolean {
  return /^v[0-9]/.test(tag);
}

export function selectLatestWebTag(
  releases: ReadonlyArray<{ tag_name?: string | undefined }>,
): string | null {
  for (const release of releases) {
    const tag = release.tag_name;
    if (typeof tag === "string" && isWebReleaseTag(tag)) return tag;
  }
  return null;
}

export function workersTarballName(tag: string): string {
  return `lexa-workers-${tag}.tar.gz`;
}

export function releaseForTag(tag: string, repo: string = LEXA_REPO): ReleaseInfo {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  return {
    tag,
    tarballUrl: `${base}/${workersTarballName(tag)}`,
    checksumsUrl: `${base}/checksums.txt`,
  };
}

export type ReleaseFetcher = (url: string, init?: RequestInit) => Promise<Response>;

// Resolve the newest web-app release to `{ tag, tarballUrl, checksumsUrl }`.
// The fetcher is injectable so callers/tests avoid the network.
export async function resolveWorkersRelease(
  fetchFn: ReleaseFetcher = fetch,
  repo: string = LEXA_REPO,
): Promise<ReleaseInfo> {
  let res: Response;
  try {
    res = await fetchFn(releasesListUrl(repo), {
      headers: { "User-Agent": "lx", Accept: "application/vnd.github+json" },
    });
  } catch (e) {
    throw new ReleaseError({ reason: "resolve-failed", detail: (e as Error).message ?? String(e) });
  }
  if (!res.ok) throw new ReleaseError({ reason: "resolve-failed", status: res.status });
  const releases = (await res.json()) as Array<{ tag_name?: string | undefined }>;
  const tag = selectLatestWebTag(releases);
  if (!tag) throw new ReleaseError({ reason: "no-release" });
  return releaseForTag(tag, repo);
}

// `<sha256>  <filename>` lines (sha256sum output; `*` marks binary mode).
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(raw.trim());
    if (!match) continue;
    sums.set(basename(match[2]!.trim()), match[1]!.toLowerCase());
  }
  return sums;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Verify a downloaded tarball's bytes against checksums.txt. A missing entry
// or a hash mismatch throws a typed ReleaseError (install-lib.sh warns on a
// missing checksums.txt instead; the CLI treats it as a hard failure).
export function verifyTarballChecksum(
  data: Uint8Array,
  checksumsText: string,
  tarballName: string,
): void {
  const name = basename(tarballName);
  const expected = parseChecksums(checksumsText).get(name);
  if (expected === undefined) {
    throw new ReleaseError({ reason: "checksum-missing", tarballName: name });
  }
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new ReleaseError({ reason: "checksum-mismatch", tarballName: name, expected, actual });
  }
}
