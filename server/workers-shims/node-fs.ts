// Workerd bundler shim for `node:fs` (wired via the `alias` field in
// wrangler.jsonc for source `wrangler dev`, and via the workers-branch
// resolve.alias in vite.config.ts for `vite build`). No filesystem exists
// on Workers — every stub throws when called. Bun-only modules that import
// it statically (server/storage/drivers.ts via the Storage service,
// server/db/*) stay in the module graph but their fs paths never execute
// on the Workers flavor (R2 driver / D1 driver serve those roles).
// Bun and vitest never use this file.

const SHIM_MARKER = "lexa-workers-node-fs-shim";

function fail(name: string): never {
  throw new Error(`${SHIM_MARKER}: node:fs.${name} is unavailable on Workers`);
}

export function mkdirSync(..._args: unknown[]): never { fail("mkdirSync"); }
export function readdirSync(..._args: unknown[]): never { fail("readdirSync"); }
export function readFileSync(..._args: unknown[]): never { fail("readFileSync"); }
export function rmSync(..._args: unknown[]): never { fail("rmSync"); }
export function statSync(..._args: unknown[]): never { fail("statSync"); }
export function writeFileSync(..._args: unknown[]): never { fail("writeFileSync"); }
export function chmodSync(..._args: unknown[]): never { fail("chmodSync"); }
export function existsSync(..._args: unknown[]): boolean { return false; }

export default { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync };
