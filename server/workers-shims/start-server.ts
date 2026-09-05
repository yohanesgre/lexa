// Workerd bundler shim for `@tanstack/react-start/server` (wired via the
// `alias` field in wrangler.jsonc). The real subpath pulls Vite-virtual
// modules (`#tanstack-router-entry`, `#tanstack-start-entry`,
// `tanstack-start-manifest:v`) that only exist inside the TanStack Start
// vite build pipeline — unresolvable when wrangler bundles
// server/workers-entry.ts source directly for `wrangler dev`.
//
// The production path does not use this file: `vite build` (workers
// flavor) never reads wrangler.jsonc `alias`, so the built worker links
// the real Start server handler and serves SSR pages. In source dev the
// stubs below throw, and the entry falls back to its no-SSR page for
// non-API routes. Every stub carries the same marker so the built output
// can be audited for accidental shim linkage (see workers-b6 report).

const SHIM_MARKER = "lexa-workers-start-server-shim";

export function createStartHandler(..._args: unknown[]): (req: Request) => Promise<Response> {
  const err = new Error(`${SHIM_MARKER}: TanStack Start SSR needs the vite workers build — run LEXA_FLAVOR=workers bun run build`);
  return () => Promise.reject(err);
}

export function defaultStreamHandler(..._args: unknown[]): Promise<Response> {
  return Promise.reject(new Error(`${SHIM_MARKER}: TanStack Start SSR needs the vite workers build`));
}
