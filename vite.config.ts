import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

const isWorkersBuild =
  process.env.LEXA_FLAVOR === "workers" || process.env.CF_WORKERS === "1";

export default defineConfig(async ({ command, isPreview }) => {
  // TanStack Start's prerender step runs `vite.preview` in-process, which
  // re-evaluates this config with command "serve" + isPreview true. The
  // Workers build must also disable remote bindings on that preview pass —
  // `command === "build"` alone never reaches it.
  const isWorkersBuildOrPreview = isWorkersBuild && (command === "build" || isPreview);
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
    plugins.unshift(
      cloudflare({
        viteEnvironment: { name: "ssr" },
        // `ai` is a permanent-remote binding (workers-sdk marks it
        // DO-NOT-USE-this-resource-will-never-have-a-local-simulator; miniflare
        // has no local simulator). With remote bindings enabled the plugin
        // starts its remote-bindings proxy during the build's prerender preview
        // pass, which needs Cloudflare credentials in non-interactive CI and
        // keeps the process alive after the build. The production deploy config
        // still carries `ai` (root wrangler.jsonc, transcribed by
        // scripts/workers-install.ts) — this only affects the local config the
        // build runs against. `dev:workers` (serve) keeps the real binding and
        // its remote-proxy + token behavior.
        ...(isWorkersBuildOrPreview ? { remoteBindings: false } : {}),
      }),
    );
  }

  if (command === "serve") {
    const { default: Inspect } = await import("vite-plugin-inspect");
    plugins.unshift(Inspect({ build: false }));
  }

  // Dev API proxy target. Defaults to the local Bun entry; `LEXA_DEV_API_TARGET`
  // points it at a remote server (e.g. staging) so localhost serves that
  // server's contents. A remote target needs the outgoing Origin rewritten to
  // the target origin, otherwise Better Auth rejects cookie-bearing POSTs with
  // INVALID_ORIGIN (staging trusts only its own publicUrl).
  const apiTarget = process.env.LEXA_DEV_API_TARGET || "http://localhost:3000";
  const apiTargetOrigin = new URL(apiTarget).origin;
  const apiTargetHostname = new URL(apiTarget).hostname;
  const isLoopbackTarget =
    apiTargetHostname === "localhost" ||
    apiTargetHostname === "127.0.0.1" ||
    apiTargetHostname === "0.0.0.0" ||
    apiTargetHostname === "[::1]" ||
    apiTargetHostname === "::1" ||
    apiTargetHostname === "[::]" ||
    apiTargetHostname === "::";

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
      // Bun flavor: API and frontend are separate processes, so vite proxies
      // /api to the Bun entry on :3000. Workers flavor: one workerd instance
      // co-hosts the handler and the API — proxying would send /api to the
      // (absent) Bun host and 502, so the worker must handle it directly.
      ...(isWorkersBuild
        ? {}
        : {
            proxy: {
              "/api": {
                target: apiTarget,
                changeOrigin: true,
                secure: true,
                ws: true,
                // Remote target: rewrite the forwarded Origin to the target's
                // origin so Better Auth's trustedOrigins check passes. Loopback
                // targets keep the incoming Origin (local dev trusts :5173).
                ...(isLoopbackTarget
                  ? {}
                  : {
                      rewriteWsOrigin: true,
                      configure: (proxy) => {
                        proxy.on("proxyReq", (proxyReq) => {
                          proxyReq.setHeader("Origin", apiTargetOrigin);
                        });
                      },
                    }),
              },
            },
          }),
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
