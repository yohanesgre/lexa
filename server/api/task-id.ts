import { Effect } from "effect";
import { Sqlite, queryFirst, DbError } from "../db/database";
import { parseTaskKey } from "../task-key";

// Route param may be a UUID or a KEY-N ticket key. Key hits resolve to the
// task UUID; misses return the raw param so TaskNotFound echoes what the
// caller sent. When the route slug is given, a key whose task lives in a
// different project also returns the raw param → 404 (the slug is redundant
// for globally-unique keys, but the URL must stay honest).
export function resolveTaskId(raw: string, slug?: string): Effect.Effect<string, DbError, Sqlite> {
  return Effect.gen(function* () {
    if (!parseTaskKey(raw)) return raw;
    const db = yield* Sqlite;
    const row = yield* queryFirst<{ id: string; project_slug: string }>(
      db,
      "SELECT t.id, p.slug AS project_slug FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.key = ?",
      raw.toUpperCase()
    ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
    if (!row) return raw;
    if (slug && row.project_slug !== slug) return raw;
    return row.id;
  });
}