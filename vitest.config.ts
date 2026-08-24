import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Vitest workers run under node — bun:sqlite is a bun runtime builtin.
      // Route it to a node:sqlite-backed shim for tests only.
      "bun:sqlite": fileURLToPath(new URL("./server/db/bun-sqlite.shim.ts", import.meta.url)),
    },
  },
  test: {
    include: ["shared/**/*.test.ts", "server/**/*.test.ts", "app/**/*.test.{ts,tsx}", "cli/src/**/*.test.ts", "hearth/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: true,
  },
});
