// The CLI version is INDEPENDENT of the web app version (see AGENTS.md).
// Single source of truth: cli/package.json — bundled into compiled binaries,
// so this file is static (no regeneration step, no env plumbing).
import pkg from "../package.json";

export const CLI_VERSION = pkg.version;
