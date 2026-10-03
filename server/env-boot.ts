// Boot-time env-file side effect: import this FIRST so the file's values land
// in `process.env` before any module that snapshots env at import scope
// evaluates its constants (server/auth.ts, server/api/limits.ts,
// server/logging/logger.ts). ES module bodies evaluate in import order, so a
// plain `applyEnvFile()` called after the imports runs too late — after every
// static import has already captured the process env.
//
// A present .env.toml that cannot be read or parsed is a hard boot failure —
// exiting non-zero with a path-naming message — never a silent fall back to
// defaults. A genuinely absent file still warns and uses the process env.
//
// Not for Workers: imports server/env-file.ts (node:fs).
import { applyEnvFile, type ApplyEnvFileResult } from "./env-file";

let envFile: ApplyEnvFileResult;
try {
  envFile = applyEnvFile();
} catch (e) {
  console.error(`env-file: FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (envFile.path) console.log(`env-file: loaded ${envFile.path}`);
else console.log("env-file: no .env.toml or .env found — using the process environment");
