import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: "app",
      router: {
        routeFileIgnorePattern: "\\.test\\.",
      },
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  optimizeDeps: {
    // Server-only packages must never be pre-bundled for the client: the dep
    // optimizer statically scans literal imports (e.g. auth-session.server.ts)
    // and would try to resolve @tanstack/react-start-server, whose
    // createStartHandler references the #tanstack-router-entry virtual that
    // only the TanStack Start plugin defines at build time.
    exclude: ["@tanstack/react-start-server", "@tanstack/start-server-core"],
  },
  ssr: {
    // server/auth.ts runs in the Bun API server, never in vite SSR; keep
    // its bun: imports out of the node-based SSR loader.
    external: ["bun:sqlite"],
  },
});
