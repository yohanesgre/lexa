import { defineConfig } from "vite";
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
    }),
    react(),
    tailwindcss(),
  ];

  if (isWorkersBuild) {
    const { cloudflare } = await import("@cloudflare/vite-plugin");
    plugins.unshift(cloudflare({ viteEnvironment: { name: "ssr" } }));
  }

  return {
    plugins,
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
