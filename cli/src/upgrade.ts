// lexa-cli upgrade — self-update the CLI binary (GitHub release). Web app
// upgrades go through `lexa-cli deploy` (it pulls the latest image by
// default; --image pins a tag; --clean recreates the data volume).
//
// CLI releases are INDEPENDENT of web app releases: cli-vX.Y.Z tags publish
// the binary as a GitHub release asset; vX.Y.Z tags publish the app image to
// ghcr.io. So upgrade resolves the newest cli-v* tag via the API — never
// `releases/latest`, which may be a web app release without the asset.
import { Effect } from "effect";
import { spawnSync } from "node:child_process";
import { chmodSync, renameSync } from "node:fs";
import { COMPILED } from "./machine";
import { CLI_VERSION } from "./version";

const GH_API = "https://api.github.com/repos/yohanesgre/lexa/releases?per_page=100";

export function cliTagToVersion(tag: string): string | null {
  const m = /^cli-v([0-9.]+)$/.exec(tag);
  return m ? m[1]! : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Newest cli-v* release tag on GitHub, or null (API failure / none published).
async function latestCliTag(): Promise<string | null> {
  try {
    const res = await fetch(GH_API, { headers: { "User-Agent": "lexa-cli", Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{ tag_name: string }>;
    const tags = releases.map((r) => r.tag_name).filter((t) => cliTagToVersion(t) !== null);
    if (tags.length === 0) return null;
    tags.sort((a, b) => compareVersions(cliTagToVersion(b)!, cliTagToVersion(a)!));
    return tags[0]!;
  } catch {
    return null;
  }
}

export const cmdUpgradeCli = Effect.fn("LexaCli/cmdUpgradeCli")(function* () {
  if (!COMPILED) {
    console.error("  Running from source — nothing to self-update.");
    console.error("  Upgrade the repo (git pull) and recompile: bun run compile:cli");
    process.exit(1);
  }
  console.log(`  Installed CLI: ${CLI_VERSION}`);
  const latest = yield* Effect.promise(() => latestCliTag());
  if (!latest) {
    throw new Error(`could not resolve the latest cli-v* release (GitHub API failed or none published)`);
  }
  const latestVersion = cliTagToVersion(latest)!;
  if (CLI_VERSION !== "dev" && compareVersions(CLI_VERSION, latestVersion) >= 0) {
    console.log(`  Already up to date (latest: ${latest}).`);
    return;
  }
  const self = process.execPath;
  const url = `https://github.com/yohanesgre/lexa/releases/download/${latest}/lexa-cli`;
  console.log(`==> Upgrading CLI at ${self}`);
  console.log(`  ${CLI_VERSION} → ${latest} (${url})`);
  const tmp = `${self}.new`;
  const result = spawnSync("curl", ["-fsSL", "-o", tmp, url], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`download failed (curl status ${result.status ?? "?"})`);
  }
  const size = (yield* Effect.promise(() => Bun.file(tmp).stat())).size;
  if (size < 1024 * 1024) {
    throw new Error(`downloaded file looks wrong (${size} bytes) — aborting`);
  }
  chmodSync(tmp, 0o755);
  renameSync(tmp, self);
  console.log(`  Installed ${self} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  console.log("  Restart the listener to pick up the new binary:");
  console.log("    lexa-cli machine restart   (if the systemd unit is installed)");
});
