import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../../server/auth";

// Better Auth mount (BE-owned FE-tree exception, orchestrator-approved).
// Requests reach this handler via the TanStack SSR server; the Bun server
// (server/entry.ts) short-circuits /api/auth/* to auth.handler BEFORE the
// API-key middleware, so this route is the same handler on the SSR side.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => auth.handler(request),
      POST: async ({ request }: { request: Request }) => auth.handler(request),
    },
  },
});
