/**
 * Compile lx into the standalone prod binary.
 *
 *   bun run compile:cli
 *
 * Runs `bun build --compile --minify cli/src/index.ts` → bin/lx.
 *
 * The compiled binary is distributed via `scripts/install-cli.sh`
 * (downloads the GitHub release asset) — there is no repo install step.
 *
 * Install/uninstall (dev shim only):
 *   bun run install:cli-dev  → ~/.local/bin/lx-dev (shim → live repo
 *                              source via bun; never overwrites the prod name)
 *   bun run uninstall:cli-dev → removes the dev shim
 *
 * The CLI version is NOT regenerated: it is read from cli/package.json
 * (static, see cli/src/version.ts).
 */
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outfile = join(root, "bin", "lx");

mkdirSync(join(root, "bin"), { recursive: true });
const result = spawnSync(
  "bun",
  ["build", "--compile", "--minify", "--outfile", outfile, join(root, "cli", "src", "index.ts")],
  { stdio: "inherit" },
);
const compileStatus = result.status ?? 1;
if (compileStatus !== 0) {
  console.error(`  Compile failed (exit ${compileStatus})`);
  process.exit(compileStatus);
}
const size = (await Bun.file(outfile).stat()).size;
console.log(`  Compiled → ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  Distribute:  scripts/install-cli.sh (downloads the GitHub release asset)`);
console.log(`  Dev shim:    bun run install:cli-dev  (→ ~/.local/bin/lx-dev)`);
