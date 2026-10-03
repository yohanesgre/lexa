// The CLI version is INDEPENDENT of the web app version (see AGENTS.md).
// Single source of truth: cli/package.json — bundled into compiled binaries,
// so this file is static (no regeneration step, no env plumbing).
//
// This module also owns the deployed web-app version helpers: the installer
// stamps `vars.LXK_VERSION` (scripts/lib/cf-deploy.ts) and `lx worker upgrade`
// compares it against the latest release before acting.
import pkg from "../package.json";
import { resolveWorkersRelease, type ReleaseFetcher } from "./release";
import { compareVersions } from "./upgrade";

export const CLI_VERSION = pkg.version;

// The numeric comparator (cli self-update) re-exported so command code has a
// single version surface.
export { compareVersions };

// A resolved per-deploy wrangler config (parsed JSON). The version marker
// lives under `vars`, alongside the public URL.
export interface ResolvedDeployConfig {
  vars?: Record<string, unknown> | undefined;
}

// The web-app version stamped at deploy time, or null when the config predates
// the marker (or is malformed) — the caller warns rather than guessing.
export function readDeployedVersion(
  config: ResolvedDeployConfig | null | undefined,
): string | null {
  const vars = config?.vars;
  if (typeof vars !== "object" || vars === null) return null;
  const version = (vars as Record<string, unknown>).LXK_VERSION;
  return typeof version === "string" && version.length > 0 ? version : null;
}

// `v2026.6.2` → `2026.6.2` (release tags carry the `v` prefix).
export function webTagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

// Latest published web-app version, via the release resolver (tag anchored on
// `v[0-9]`, never GitHub's `releases/latest`). The fetcher is injectable so
// callers and tests avoid the network.
export async function resolveLatestVersion(
  fetchFn?: ReleaseFetcher,
): Promise<string> {
  const release = await resolveWorkersRelease(fetchFn);
  return webTagToVersion(release.tag);
}

// True only when both versions are known and equal — `lx worker upgrade`
// refuses to act on this (nothing newer to install).
export function sameVersion(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  if (!current || !latest) return false;
  return compareVersions(current, latest) === 0;
}
