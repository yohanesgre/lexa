// Workerd bundler shim for `better-auth/tanstack-start` (wired via the
// `alias` field in wrangler.jsonc). That subpath imports Vite-virtual
// modules (#tanstack-start-entry, tanstack-start-manifest:v) that only
// exist inside the TanStack Start build pipeline — unresolvable when
// wrangler bundles server/workers-entry.ts directly.
//
// The export it provides, tanstackStartCookies(), only matters when
// CONSTRUCTING a better-auth instance with cookie support. The Workers
// entry never constructs one (session-cookie auth is unsupported until
// the better-auth D1 adapter lands — see server/workers-entry.ts), so
// this no-op plugin object is never invoked. The Bun host never uses
// this file.
export function tanstackStartCookies() {
  return { id: "lexa-workers-noop-cookies" };
}
