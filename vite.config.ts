import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    tanstackStart({ srcDirectory: "app" }),
    react(),
    tailwindcss(),
  ],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3000",
      // MCP is server-side only (not part of the SPA) — proxy it so the
      // daemon can use the same LEXA_URL as the browser (:5173).
      "/mcp": "http://localhost:3000",
    },
  },
  ssr: {
    // server/auth.ts runs in the Bun API server, never in vite SSR; keep
    // its bun: imports out of the node-based SSR loader.
    external: ["bun:sqlite"],
  },
});
