// Workerd bundler shim for `bun:sqlite` (mirrors the vitest.config.ts
// alias, which routes it to a node:sqlite shim for tests). Wired via the
// `alias` field in wrangler.jsonc (and the generated deploy configs).
//
// Never constructed on Workers — any use throws. The Workers entry only
// reaches modules that reference the `Database` TYPE through this import
// (server/auth.ts via github.service's PUBLIC_URL const); every runtime
// `new Database()` site lives in Bun-only modules the worker never
// imports. The Bun host never uses this file.
export class Database {
  constructor(..._args: unknown[]) {
    throw new Error("bun:sqlite is unavailable on Workers — use the D1 driver (DbD1Live)");
  }
}
