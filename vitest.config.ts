import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Vitest workers run under node — bun:sqlite is a bun runtime builtin.
      // Route it to a node:sqlite-backed shim for tests only.
      "bun:sqlite": fileURLToPath(new URL("./server/db/bun-sqlite.shim.ts", import.meta.url)),
      // `cloudflare:workers` is a workerd builtin; the assistant DO class pulls
      // it in transitively via `agents` / `@cloudflare/ai-chat`. Route it to a
      // stub for tests only.
      "cloudflare:workers": fileURLToPath(
        new URL("./server/assistant/cloudflare-workers.shim.ts", import.meta.url)
      ),
      // `agents` also imports `EmailMessage` from the workerd-only
      // `cloudflare:email` builtin; same shim.
      "cloudflare:email": fileURLToPath(
        new URL("./server/assistant/cloudflare-workers.shim.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["shared/**/*.test.ts", "server/**/*.test.ts", "app/**/*.test.{ts,tsx}", "cli/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Migration + HTTP integration suites exceed Vitest's 5s default under
    // parallel workers; a genuine hang still fails at 15s.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    passWithNoTests: true,
    // Migration + HTTP integration suites run real SQLite migrations and HTTP
    // round-trips under parallel workers; they routinely exceed Vitest's 5s
    // default. A genuine hang still fails at 15s.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    server: {
      deps: {
        // node_modules are externalized by default, so the `cloudflare:workers`
        // alias above never runs for the packages that import it. Inline just
        // those two so vite resolves their `cloudflare:workers` to the shim.
        inline: [
          /[\\/]node_modules[\\/]agents[\\/]/,
          /[\\/]node_modules[\\/]@cloudflare[\\/]ai-chat[\\/]/,
        ],
      },
    },
  },
});
