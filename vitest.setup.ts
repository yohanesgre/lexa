import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// React 19 needs the act-environment flag in test runtimes.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// server/auth.ts opens its better-auth DB at import time from DATABASE_PATH.
// Without a writable default the import crashes every worker; with a shared
// test path every worker would race on one file. Give each worker its own
// tmp DB — tests that need a specific DB override the env before importing.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "lexa-vitest-auth-")), "auth.db");

afterEach(() => {
  cleanup();
});
