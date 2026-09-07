import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const isWorkersBuild =
  process.env.LEXA_FLAVOR === "workers" || process.env.CF_WORKERS === "1";

export default defineConfig(async ({ command }) => {
  const plugins: import("vite").PluginOption[] = [
    tanstackStart({
      srcDirectory: "app",
      router: {
        routeFileIgnorePattern: "\\.test\\.",
      },
      // SPA shell for ssr:false routes must be prerendered at build —
      // without this the build skips /_shell and those routes serve a
      // headless fragment (no <html>/<head>, blank page).
      spa: { enabled: true },
    }),
    react(),
    tailwindcss(),
  ];

  if (isWorkersBuild) {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    plugins.unshift(cloudflare({ viteEnvironment: { name: "ssr" } }));
  }

  if (command === "serve") {
    const { default: Inspect } = await import("vite-plugin-inspect");
    plugins.unshift(Inspect({ build: false }));
  }

  return {
    plugins,
    resolve: {
      // Workers flavor only: neutralize host-only modules the workerd
      // runtime cannot provide. Mirrors the wrangler.jsonc `alias` (which
      // covers source `wrangler dev`) and the vitest.config.ts alias for
      // bun:sqlite — the vite build reads neither, so it needs its own.
      // The aliased stubs never execute on this flavor (D1/R2 serve those
      // roles; SSR links the real Start handler — see workers-b6 report).
      ...(isWorkersBuild
        ? {
            alias: {
              "bun:sqlite": fileURLToPath(new URL("./server/workers-shims/bun-sqlite.ts", import.meta.url)),
              "node:fs": fileURLToPath(new URL("./server/workers-shims/node-fs.ts", import.meta.url)),
            },
          }
        : {}),
    },
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
    optimizeDeps: {
      exclude: ["@tanstack/react-start-server", "@tanstack/start-server-core"],
    },
    ...(isWorkersBuild
      ? {}
      : {
          ssr: {
            external: ["bun:sqlite"],
          },
        }),
  };
});
