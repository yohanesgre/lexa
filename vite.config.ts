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
        // Route code splitting is framework-native and on by default. It also
        // splits pendingComponent into its own lazy chunk — without this the
        // route shell eagerly imports whatever module exports the pending
        // skeleton, which dragged the whole TipTap editor graph into the
        // boot bundle (tasks_.$taskId's pending skeleton lives next to
        // TaskDetail). Loaders stay in the shell so prefetching still runs
        // before navigation.
        autoCodeSplitting: true,
        codeSplittingOptions: {
          defaultBehavior: [
            ["component"],
            ["pendingComponent"],
            ["errorComponent"],
            ["notFoundComponent"],
          ],
        },
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
        // has no local simulator). Remote bindings would make the plugin open
        // its remote-bindings proxy at serve time and during the build's
        // prerender preview pass — the serve proxy stalls boot at
        // "Establishing remote connection..." (needs Cloudflare credentials),
        // and the preview pass keeps the build process alive in CI. Disabling
        // them keeps local dev token-free. Consequence: `workers_ai` assistant
        // models do not work locally; external providers do. The production
        // deploy config still carries `ai` (root wrangler.jsonc, transcribed by
        // scripts/workers-install.ts) — this only affects the local config the
        // plugin runs against.
        remoteBindings: false,
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
    build: {
      rollupOptions: {
        output: {
          // Vendor groups split by concern so a route that does not mount the
          // editor/assistant never downloads their chunks, and framework code
          // stays in cache-stable files across app deploys. The app/route code
          // itself is split by TanStack's autoCodeSplitting (above); unmatched
          // node_modules keep Rolldown's default shared-chunk behavior.
          //
          // Native Rolldown groups (not Rollup-compat `manualChunks`): the
          // manualChunks shim runs one group with includeDependenciesRecursively
          // defaulting true, so @tiptap/react's deps (react-dom base,
          // use-sync-external-store) were swallowed into vendor-editor — and
          // since the entry chunk needs react-dom, the whole editor graph was
          // modulepreloaded on boot. Explicit groups + priority let the react
          // group claim its modules first, so vendor-editor stays tiptap-only.
          codeSplitting: {
            groups: [
              {
                name: "vendor-react",
                test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
                priority: 20,
              },
              {
                name: "vendor-editor",
                test: /node_modules[\\/](@tiptap|prosemirror|orderedmap|rope-sequence|w3c-keyname|linkifyjs|@floating-ui)[\\/]/,
                priority: 10,
              },
              {
                name: "vendor-assistant",
                test: /node_modules[\\/](partysocket|@ai-sdk|@cloudflare[\\/]ai-chat|@tanstack[\\/]ai|ai)[\\/]/,
                priority: 12,
              },
              {
                name: "vendor-markdown",
                test: /node_modules[\\/](marked|highlight\.js)[\\/]/,
                priority: 10,
              },
              {
                name: "vendor-icons",
                test: /node_modules[\\/](lucide-react|@phosphor-icons)[\\/]/,
                priority: 10,
              },
              {
                name: "vendor-tanstack",
                test: /node_modules[\\/]@tanstack[\\/]/,
                priority: 10,
              },
              {
                name: "vendor-effect",
                test: /node_modules[\\/](effect|@effect)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
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
