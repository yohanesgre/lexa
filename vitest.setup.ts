import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// React 19 needs the act-environment flag in test runtimes.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement pointer capture — GanttChart drag tests dispatch
// real pointer events, so every drag would throw an unhandled TypeError
// (tests still pass but vitest counts the errors). Guarded: node-env tests
// (server/shared) have no HTMLElement at all.
if (typeof HTMLElement !== "undefined") {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
}

// server/auth.ts opens its better-auth DB at import time from DATABASE_PATH.
// Without a writable default the import crashes every worker; with a shared
// test path every worker would race on one file. Give each worker its own
// tmp DB — tests that need a specific DB override the env before importing.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "lexa-vitest-auth-")), "auth.db");

// server/auth.ts fails closed without a signing secret (better-auth would
// otherwise use its forgeable library default). All test workers share this
// fixed key; tests that exercise secrets-disabled behavior delete/override it
// per-file (isolated workers keep that local).
process.env.LXK_SECRETS_MASTER_KEY = Buffer.from("vitest-auth-secret-00000000000000").toString("base64");

afterEach(() => {
  cleanup();
});
