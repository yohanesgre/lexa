/**
 * Compile lx into the standalone prod binary.
 *
 *   bun run compile:cli
 *
 * Bundles the Hearth daemon (hearth/daemon.ts imports shared modules) —
 * the bundled JS is embedded into cli/src/packed.ts so the compiled
 * binary can write it to ~/.local/share/lexa-hearth/daemon.js — then runs
 * `bun build --compile` → bin/lx.
 *
 * The compiled binary is distributed via `scripts/install-cli.sh`
 * (downloads the GitHub release asset) — there is no repo install step.
 *
 * Install/uninstall (dev shim only):
 *   bun run install:cli-dev  → ~/.local/bin/lx-dev (shim → live repo
 *                              source via bun; never overwrites the prod name)
 *   bun run uninstall:cli-dev → removes the dev shim
 *
 * Note: this regenerates cli/src/packed.ts (daemon embed) for the duration of
 * the compile. The committed stub is written back on exit — success or
 * failure — so no manual `git checkout cli/src/packed.ts` is needed.
 * The CLI version is NOT regenerated: it is read from cli/package.json
 * (static, see cli/src/version.ts).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { PACKED_STUB, packedEmbed } from "../cli/src/packed-embed";

const root = join(import.meta.dir, "..");
const daemonPath = join(root, "hearth", "daemon.ts");
const packedPath = join(root, "cli", "src", "packed.ts");
const outfile = join(root, "bin", "lx");
const bundlePath = join(root, "bin", "daemon-bundle.js");

if (!existsSync(daemonPath)) {
  console.error(`  Daemon source missing at ${daemonPath}`);
  process.exit(1);
}

// The daemon imports shared modules (shared/hearth-log.ts) — bundle it so the
// embedded copy is self-contained on machines without the repo.
mkdirSync(join(root, "bin"), { recursive: true });
const bundle = spawnSync("bun", ["build", "--target=bun", "--outfile", bundlePath, daemonPath], { stdio: "pipe" });
if (bundle.status !== 0) {
  console.error(`  Daemon bundle failed: ${bundle.stderr?.toString().slice(0, 500)}`);
  process.exit(1);
}
const source = readFileSync(bundlePath, "utf-8");
rmSync(bundlePath, { force: true });

let compileStatus = 0;
try {
  writeFileSync(packedPath, packedEmbed(source));
  const result = spawnSync(
    "bun",
    ["build", "--compile", "--minify", "--outfile", outfile, join(root, "cli", "src", "index.ts")],
    { stdio: "inherit" },
  );
  compileStatus = result.status ?? 1;
  if (compileStatus !== 0) {
    console.error(`  Compile failed (exit ${compileStatus})`);
  } else {
    const size = (await Bun.file(outfile).stat()).size;
    console.log(`  Compiled → ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`  Distribute:  scripts/install-cli.sh (downloads the GitHub release asset)`);
    console.log(`  Dev shim:    bun run install:cli-dev  (→ ~/.local/bin/lx-dev)`);
  }
} finally {
  // Restore the committed stub even when the compile fails — a leftover embed
  // would make source listeners run a stale daemon.
  writeFileSync(packedPath, PACKED_STUB);
}
if (compileStatus !== 0) process.exit(compileStatus);
