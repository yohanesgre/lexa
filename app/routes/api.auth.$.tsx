import { createFileRoute } from "@tanstack/react-router";

// Better Auth mount (BE-owned FE-tree exception, orchestrator-approved).
// Requests reach this handler via the TanStack SSR server; the Bun server
// (server/entry.ts) short-circuits /api/auth/* to auth.handler BEFORE the
// API-key middleware, so this route is the same handler on the SSR side.
// Lazy-loaded: server/auth.ts binds bun:sqlite at import time, which the
// vite SSR loader cannot execute — dynamic import keeps it out of the SSR
// static graph (only evaluated at request time under the Bun server).
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) =>
        (await import("../../server/auth")).auth.handler(request),
      POST: async ({ request }: { request: Request }) =>
        (await import("../../server/auth")).auth.handler(request),
    },
  },
});
