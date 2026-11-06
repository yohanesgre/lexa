import { Effect } from "effect";
import type { DbDriver } from "../db/db";
import { assertMarkdownReady } from "../db/document-format";

export const isMarkdownReadinessExemptPath = (pathname: string): boolean =>
  pathname === "/health" || pathname === "/api/health" ||
  pathname === "/setup" || pathname.startsWith("/setup/") ||
  pathname === "/api/setup" || pathname.startsWith("/api/setup/") ||
  pathname === "/auth" || pathname.startsWith("/auth/") ||
  pathname === "/api/auth" || pathname.startsWith("/api/auth/");

// Per-handler (= per isolate in the Workers entry) readiness memo. The
// documents.format setting is immutable once migrated, so a successful check
// is cached for the isolate's life. A failure clears the slot so the next
// request retries instead of pinning a transient D1 error.
export function createMarkdownReadinessGate(driver: DbDriver): () => Promise<void> {
  let ready: Promise<void> | null = null;
  return () => {
    ready ??= Effect.runPromise(assertMarkdownReady(driver)).catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };
}
