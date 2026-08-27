// Tests for `runMigrationsD1` (Phase 8). The function takes a
// `D1MigrationRunner` interface; this test implements an in-process
// stub that mimics the D1 binding's `prepare`/`batch` surface. Real
// workerd D1 verification happens via `bunx wrangler dev` and
// `wrangler d1 migrations apply --local`; the stub is enough to prove
// the algorithm (idempotency, per-file atomicity, registry writes).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach } from "vitest";
import { runMigrationsD1, type D1MigrationRunner } from "./migrate";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

type Table = Record<string, unknown>[];

function makeStubRunner(): D1MigrationRunner & { _table(name: string): Table } {
  // In-memory store. Each "table" is a list of row objects.
  const tables: Record<string, Table> = {};

  const stub: D1MigrationRunner & { _table(name: string): Table } = {
    prepare(sql: string) {
      const stmt = {
        _bound: [] as unknown[],
        bind(...params: unknown[]) {
          stmt._bound = params;
          return stmt;
        },
        async all<T>(): Promise<T[]> {
          return [] as T[];
        },
        async first<T>(): Promise<T | null> {
          if (/SELECT name FROM _migrations WHERE name = \?/.test(sql)) {
            const name = stmt._bound[0]! as string;
            const rows = tables["_migrations"] ?? [];
            const hit = rows.find((r) => r.name === name);
            return (hit ? { name: hit.name } : null) as T | null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO _migrations \(name\) VALUES \(\?\)/.test(sql)) {
            const name = stmt._bound[0]! as string;
            const rows = tables["_migrations"] ?? [];
            rows.push({ name, applied_at: new Date().toISOString() });
            tables["_migrations"] = rows;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: { sql: string; params?: unknown[] }[]) {
      // The D1 binding runs statements in a single transaction. Our
      // stub is a no-op DDL parser: it tracks the _migrations table
      // bootstrap and the registry inserts. Real SQL execution is
      // delegated to workerd / miniflare in the integration tests.
      for (const s of stmts) {
        if (/CREATE TABLE IF NOT EXISTS _migrations/.test(s.sql)) {
          if (!tables["_migrations"]) tables["_migrations"] = [];
          continue;
        }
        if (/INSERT INTO _migrations \(name\) VALUES \(\?\)/.test(s.sql)) {
          const name = s.params?.[0] as string;
          const rows = tables["_migrations"] ?? [];
          rows.push({ name, applied_at: new Date().toISOString() });
          tables["_migrations"] = rows;
          continue;
        }
        // Otherwise, treat the statement as a migration DDL/DML and
        // do not execute it (the stub doesn't model real schema
        // changes — that requires workerd). The tests assert that the
        // registry row lands AFTER the migration statement — the
        // D1 binding's batch() is atomic, so a failure on the
        // migration would surface as success=false and the registry
        // INSERT in the same batch never lands.
        continue;
      }
      return { success: true, duration: 1, results: [], length: stmts.length };
    },
    _table(name: string) {
      return tables[name] ?? [];
    },
  };
  return stub;
}

describe("runMigrationsD1", () => {
  let stub: ReturnType<typeof makeStubRunner>;

  beforeEach(() => {
    stub = makeStubRunner();
  });

  it("applies every migration file in order and records them in _migrations", async () => {
    const result = await runMigrationsD1(stub);
    expect(result.applied.length).toBeGreaterThan(0);
    for (const file of result.applied) {
      expect(file).toMatch(/^\d{4}_.*\.sql$/);
    }
    const rows = stub._table("_migrations");
    expect(rows.length).toBe(result.applied.length);
  });

  it("is idempotent: a second call applies nothing", async () => {
    const first = await runMigrationsD1(stub);
    expect(first.applied.length).toBeGreaterThan(0);
    const second = await runMigrationsD1(stub);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
  });

  it("passes the migration SQL + the registry INSERT as one batch per file", async () => {
    const captured: { sql: string; params?: unknown[] }[][] = [];
    const originalBatch = stub.batch.bind(stub);
    stub.batch = (async (stmts) => {
      captured.push(stmts);
      return originalBatch(stmts);
    }) as D1MigrationRunner["batch"];

    await runMigrationsD1(stub);
    const fileCount = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length;
    // 1 bootstrap batch + 1 per-file batch
    expect(captured.length).toBe(1 + fileCount);
    // Each per-file batch has exactly 2 statements: the migration + the registry row.
    for (let i = 1; i < captured.length; i++) {
      expect(captured[i]!.length).toBe(2);
      expect(captured[i]![1]!.sql).toMatch(/INSERT INTO _migrations/);
    }
  });
});
