// Boot-time env-file side effect. `server/entry.ts` imports this FIRST so the
// file's values land in `process.env` before any module that snapshots env at
// import scope evaluates its constants (server/auth.ts,
// server/api/limits.ts, server/logging/logger.ts). ES module bodies evaluate in
// import order, so a plain `applyEnvFile()` inside entry.ts's body runs too
// late — after every static import has already captured the process env.
//
// Not for Workers: imports server/env-file.ts (node:fs).
import { applyEnvFile } from "./env-file";

const envFile = applyEnvFile();
if (envFile.path) console.log(`env-file: loaded ${envFile.path}`);
else console.log("env-file: no .env.toml or .env found — using the process environment");
