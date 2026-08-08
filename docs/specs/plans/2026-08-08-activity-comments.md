# Task Activity Timeline + Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified activity timeline (system events + comments) to the task slideover, with REST + MCP surfaces, per `docs/specs/ACTIVITY_COMMENTS.md`.

**Architecture:** Two new append-only tables (`task_activity`, `task_comments`). Services append frozen-message activity rows in the same transaction as every task mutation (new invariant). Actor resolved at the boundary (browser via new `x-lxk-user` header, MCP via API key name). REST timeline endpoint merges both tables with keyset cursor; comments CRUD with author/admin authz; MCP gets read + add tools. Frontend: tab bar in the slideover, step-rail timeline, TipTap composer.

**Tech Stack:** Bun + Effect-TS (Effect.Service, Data.TaggedError, HttpApi) + SQLite (bun:sqlite), TanStack Start + React + TanStack Query + TipTap, vitest (node:sqlite shim).

## Global Constraints

- Docs are authority: `docs/SCHEMA.md`, `docs/API.md`, `docs/MCP.md`, `docs/LAYERS.md` updated **verbatim** in the task that touches them. Spec: `docs/specs/ACTIVITY_COMMENTS.md` (approved). Wireframe: `wireframes/src/task-detail.html` (already built, includes the step rail).
- **No commits** unless the user explicitly asks (project rule — skip all commit steps).
- `tsc --noEmit` must pass at every task boundary. Tests: `vitest run`.
- Names are exact: tables/columns/endpoints/tools/error codes per spec — verbatim.
- Repos are thin (prepared statements, no business logic); routes are thinner; services own domain logic and emit activity.
- **New invariant:** every task mutation appends task_activity row(s) **in the same transaction** as the mutation (`batch()` / `withTx`). Emission lives in services, never handlers.
- Invariant #6: mutation responses are authoritative — frontend `setQueryData`, never `invalidateQueries` on the mutation path.
- Invariant #7: REST speaks TipTap JSON; MCP speaks Markdown. Conversion only via `shared/markdown.ts`.
- Messages render as plain text in the UI, never HTML (XSS rule).
- TypeScript strict. No `any` outside JSON-payload boundaries.
- No comments in code unless behavior is genuinely non-obvious (auth spoofing note, rail-bounds note qualify).
- TypeScript strict. No `any` outside JSON-payload boundaries.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0004_task_activity.sql` | Create both tables + indexes + backfill |
| `shared/types.ts` | `ActorKind`, `ActivityType`, `Actor`, `ActivityEvent`, `TaskComment`, `ActivityItem` |
| `shared/db.ts` | `ActivityRow`, `CommentRow` + `rowToActivityEvent`, `rowToComment` |
| `server/activity-messages.ts` | Pure message builders per event type (frozen at write time) |
| `server/repos/activity.repo.ts` | `task_activity` keyset queries + insert |
| `server/repos/comment.repo.ts` | `task_comments` CRUD + keyset list |
| `server/services/activity.service.ts` | `append`, `listMerged` (merge + cursor) |
| `server/services/comment.service.ts` | Comment create/edit/delete + authz + validation |
| `server/api/auth-key.ts` | Key identity gains `keyName`; `x-lxk-user` header resolution |
| `server/api/middleware.ts` | Enrich `AuthIdentity` with userName + keyName |
| `server/api/errors.ts` | `COMMENT_NOT_FOUND`, `COMMENT_EDIT_FORBIDDEN`, `COMMENT_DELETE_FORBIDDEN`, `COMMENT_INVALID` + status map |
| `server/api/http.ts` | Activity/comment endpoints, response envelope, actor passing |
| `server/entry.ts` | SSR `<meta name="lxk-user">` injection |
| `server/mcp/server.ts` | `authContext` gains `keyName` |
| `server/mcp/tools/get-task-activity.ts`, `server/mcp/tools/add-task-comment.ts` | MCP tools |
| `server/services/task.service.ts` (+ task-link, source, github, forge services) | Emission points |
| `app/lib/api.ts` | `x-lxk-user` header, activity/comment client calls |
| `app/lib/queries.ts` | `useTaskActivity`, comment mutations, prepend helper, envelope consumption |
| `app/components/activity/` | `ActivityTab`, `ActivityTimeline`, `CommentCard`, `CommentComposer`, `CommentBody` |
| `app/components/TaskDetail.tsx` | Tab bar insertion |
| `app/components/layout/UserProfile.tsx` | Real identity |

## Task Dependencies

1→2→3→(4∥5)→6→7→8→(9→10→11)→12→13→14→15→16→17→18

---

### Task 1: Migration 0004 + SCHEMA.md

**Files:**
- Create: `migrations/0004_task_activity.sql`
- Modify: `docs/SCHEMA.md` (append both tables + design notes, verbatim from spec)
- Test: `server/db/migrate.test.ts` (extend)

**Interfaces:**
- Produces: tables `task_comments`, `task_activity` (rowid ids, indexes on `(task_id, created_at, id)`), backfilled `created`/`archived` rows for existing tasks.

- [ ] **Step 1: Write the failing test** (append to `server/db/migrate.test.ts`)

```ts
import { describe, expect, it } from "vitest";
// reuse existing imports/fixtures from the file (tmp db + runMigrations)

describe("0004_task_activity", () => {
  it("creates tables and backfills created/archived rows", async () => {
    const path = tmpPath();
    runMigrations(path, MIGRATIONS);
    const db = new Database(path);
    db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, archived_at)
                VALUES ('t1','p1','c1','s1','Old','a0','2026-01-01 10:00:00', '2026-02-01 10:00:00')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at)
                VALUES ('t2','p1','c1','s1','Live','a1','2026-01-02 10:00:00')`).run();

    const rows = db.prepare("SELECT task_id, type, message, actor_kind FROM task_activity ORDER BY task_id, id").all() as any[];
    expect(rows).toEqual([
      { task_id: "t1", type: "created", message: "Task created", actor_kind: "system" },
      { task_id: "t1", type: "archived", message: "Task archived", actor_kind: "system" },
      { task_id: "t2", type: "created", message: "Task created", actor_kind: "system" },
    ]);
    const cols = db.prepare("SELECT name FROM pragma_table_info('task_comments')").all() as any[];
    expect(cols.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["id", "task_id", "author_id", "author_kind", "author_label", "body", "edited_at", "deleted_at", "created_at"])
    );
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run server/db/migrate.test.ts`
Expected: FAIL — "no such table: task_activity"

- [ ] **Step 3: Create the migration** — `migrations/0004_task_activity.sql`

```sql
-- Task activity timeline + comments (docs/specs/ACTIVITY_COMMENTS.md)
-- Append-only by design: rows are never pruned (contrast: webhook_events 7-day).
-- INTEGER PRIMARY KEY: rowid is monotonic — second-granularity created_at ties
-- order by id; UUID text ids would not order chronologically.
CREATE TABLE task_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL: agent/system
  author_kind  TEXT NOT NULL DEFAULT 'user'
               CHECK (author_kind IN ('user','agent','system')),
  author_label TEXT NOT NULL,        -- frozen at write time
  body         TEXT NOT NULL,        -- TipTap JSON doc (≤64KB, non-empty)
  edited_at    TEXT,                 -- set on edit → UI "edited" marker
  deleted_at   TEXT,                 -- soft delete → hidden from timeline
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at, id);

CREATE TABLE task_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
  actor_label   TEXT NOT NULL,       -- frozen display name
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                                     -- agent: key owner; user: their id; NULL: unbound/system
  type          TEXT NOT NULL,       -- enum in shared/types.ts (no CHECK — growing set)
  message       TEXT NOT NULL,       -- frozen at write time; the record
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_activity_task ON task_activity(task_id, created_at, id);

-- Backfill: one 'created' row per existing task; archived tasks also get 'archived'.
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at)
  SELECT id, 'system', 'system', NULL, 'created', 'Task created', created_at FROM tasks;
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at)
  SELECT id, 'system', 'system', NULL, 'archived', 'Task archived', archived_at FROM tasks WHERE archived_at IS NOT NULL;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run server/db/migrate.test.ts`
Expected: PASS

- [ ] **Step 5: Update `docs/SCHEMA.md`**

Append the two CREATE TABLE blocks + index lines (verbatim from this migration) with the same header comments, after `task_links` (before `## Design Notes`). Add a Design Note: "Task activity (append-only, never pruned)" explaining rowid ids, frozen messages, actor model, backfill. Update the "Cut from v1" table row for comments if present.

---

### Task 2: Shared types + row mappers

**Files:**
- Modify: `shared/types.ts` (append after `TaskLinkSuggestion`, line ~339)
- Modify: `shared/db.ts` (append `ActivityRow`, `CommentRow`, `rowToActivityEvent`, `rowToComment`)

**Interfaces:**
- Consumes: `TipTapDoc` (exists), `TaskRow`/`rowToTask` style (exists in `shared/db.ts`).
- Produces: `ActorKind`, `ActivityType`, `Actor`, `ActivityEvent`, `TaskComment`, `ActivityItem`; `rowToActivityEvent(row)`, `rowToComment(row)` — consumed by every repo/service/api/mcp task.

- [ ] **Step 1: Add types to `shared/types.ts`**

```ts
export type ActorKind = "user" | "agent" | "system";

export type ActivityType =
  | "created" | "moved" | "field_changed" | "archived" | "restored" | "deleted"
  | "link_added" | "link_removed" | "source_added" | "source_removed"
  | "github_linked" | "github_unlinked" | "github_synced"
  | "forge_completed" | "forge_failed" | "forge_cancelled"
  | "commented" | "comment_deleted";

export interface Actor {
  kind: ActorKind;
  label: string;
  userId?: string | null;
}

export interface ActivityEvent {
  id: number;
  taskId: string;
  actorKind: ActorKind;
  actorLabel: string;
  actorUserId: string | null;
  type: ActivityType;
  message: string;
  createdAt: string;
}

export interface TaskComment {
  id: number;
  taskId: string;
  authorId: string | null;
  authorKind: ActorKind;
  authorLabel: string;
  body: TipTapDoc;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export type ActivityItem =
  | ({ kind: "event" } & ActivityEvent)
  | ({ kind: "comment" } & TaskComment);
```

- [ ] **Step 2: Add row mappers to `shared/db.ts`** (after `rowToTask`)

```ts
export interface ActivityRow {
  id: number;
  task_id: string;
  actor_kind: ActorKind;
  actor_label: string;
  actor_user_id: string | null;
  type: ActivityType;
  message: string;
  created_at: string;
}

export interface CommentRow {
  id: number;
  task_id: string;
  author_id: string | null;
  author_kind: ActorKind;
  author_label: string;
  body: string;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export function rowToActivityEvent(r: ActivityRow): ActivityEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    actorKind: r.actor_kind,
    actorLabel: r.actor_label,
    actorUserId: r.actor_user_id,
    type: r.type,
    message: r.message,
    createdAt: r.created_at,
  };
}

export function rowToComment(r: CommentRow): TaskComment {
  return {
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorKind: r.author_kind,
    authorLabel: r.author_label,
    body: JSON.parse(r.body) as TipTapDoc,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}
```

- [ ] **Step 3: Verify**

Run: `tsc --noEmit && vitest run`
Expected: PASS (existing suites unaffected).

---

### Task 3: ActivityRepo + CommentRepo

**Files:**
- Create: `server/repos/activity.repo.ts`
- Create: `server/repos/comment.repo.ts`
- Test: `server/repos/activity.repo.test.ts`, `server/repos/comment.repo.test.ts`

**Interfaces:**
- Consumes: `Sqlite` tag + `batch`/`DbError`/`RowNotFound`/`ConstraintViolation` from `../db/database`; `ActivityRow`, `CommentRow`, `rowToActivityEvent`, `rowToComment`, types from `../../shared/db` / `../../shared/types`.
- Produces: `ActivityRepo.insert(input): Effect<ActivityEvent, DbError | ConstraintViolation>`; `ActivityRepo.listByTaskKeyset(taskId, cursor: {createdAt, id} | null, limit): Effect<ActivityEvent[], DbError>` (DESC). `CommentRepo.insert/insertRaw`, `CommentRepo.findById`, `CommentRepo.updateBody`, `CommentRepo.softDelete`, `CommentRepo.listByTaskKeyset` (same keyset shape, excludes `deleted_at IS NOT NULL`). Cursor objects are `{ createdAt: string; id: number }`.

- [ ] **Step 1: Write the failing test** — `server/repos/activity.repo.test.ts` (pattern: `server/db/database.test.ts` — tmp db, `runMigrations`, `initSqlite` via `Effect.runSync(Effect.scoped(Layer.build(...)))`, raw SQL fixtures, `afterEach` cleanup)

```ts
import { describe, expect, it, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/migrate";
import { initSqlite, Sqlite } from "../db/database";
import { ActivityRepo } from "./activity.repo";

const dbs: ReturnType<typeof initSqlite>[] = [];
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-activity-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path);
  const layer = initSqlite(path);
  const db = Effect.runSync(Effect.scoped(Layer.build(layer)));
  dbs.push(db);
  return { db, dir, path };
}
afterEach(() => { for (const d of dbs) { /* close */ } dbs.length = 0; });

function seed(db: { db: import("bun:sqlite").Database; dir: string; path: string }) {
  const sql = db.db;
  sql.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  sql.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  sql.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  sql.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

describe("ActivityRepo", () => {
  it("inserts and lists rows with keyset cursor", () => {
    const f = tmpDb(); seed(f);
    const repo = Effect.runSync(ActivityRepo);
    Effect.runSync(Effect.scoped(
      Effect.gen(function* () {
        const a = yield* repo.insert({ taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "Maria created this task" });
        const b = yield* repo.insert({ taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "moved", message: "Maria moved from Todo to Done" });
        expect(a.id).toBeLessThan(b.id);
        // DESC keyset, no cursor → both, newest first
        const all = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(all.map((x) => x.type)).toEqual(["moved", "created"]);
        // cursor at the oldest → only newer excluded
        const rest = yield* repo.listByTaskKeyset("t1", { createdAt: a.createdAt, id: a.id }, 10);
        expect(rest.map((x) => x.type)).toEqual(["moved"]);
        const none = yield* repo.listByTaskKeyset("t1", { createdAt: b.createdAt, id: b.id }, 10);
        expect(none).toEqual([]);
      })
    ));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vitest run server/repos/activity.repo.test.ts`
Expected: FAIL — "Cannot find module" / service missing

- [ ] **Step 3: Implement `server/repos/activity.repo.ts`**

```ts
import { Effect, Context, Data } from "effect";
import { Sqlite, DbError, ConstraintViolation, batch } from "../db/database";
import { ActivityRow, rowToActivityEvent } from "../../shared/db";
import { ActivityEvent, ActivityType, ActorKind } from "../../shared/types";

export class ActivityRepo extends Effect.Service<ActivityRepo>()("Lexa/ActivityRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;
    const insert = (input: {
      taskId: string; actorKind: ActorKind; actorLabel: string;
      actorUserId: string | null; type: ActivityType; message: string;
    }): Effect.Effect<ActivityEvent, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const stmt = db.prepare(
          `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at`
        );
        const row = stmt.get(
          input.taskId, input.actorKind, input.actorLabel, input.actorUserId,
          input.type, input.message
        ) as ActivityRow;
        return rowToActivityEvent(row);
      });

    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<ActivityEvent[], DbError> =>
      Effect.gen(function* () {
        const stmt = db.prepare(
          `SELECT id, task_id, actor_kind, actor_label, actor_user_id, type, message, created_at
           FROM task_activity
           WHERE task_id = ?
             AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        );
        const rows = stmt.all(
          taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null,
          cursor?.createdAt ?? null, cursor?.id ?? null, limit
        ) as ActivityRow[];
        return rows.map(rowToActivityEvent);
      });

    return { insert, listByTaskKeyset };
  }),
}) {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `vitest run server/repos/activity.repo.test.ts`
Expected: PASS

- [ ] **Step 5: CommentRepo — same cycle.** Test `server/repos/comment.repo.test.ts`:

```ts
describe("CommentRepo", () => {
  it("inserts, finds, updates, soft-deletes, and lists with keyset", () => {
    const f = tmpDb(); seed(f);
    const repo = Effect.runSync(CommentRepo);
    Effect.runSync(Effect.scoped(
      Effect.gen(function* () {
        const c = yield* repo.insert({ taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Maria", body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }) });
        expect(c.id).toBeGreaterThan(0);
        const found = yield* repo.findById(c.id);
        expect(found?.authorLabel).toBe("Maria");
        const updated = yield* repo.updateBody(c.id, JSON.stringify({ type: "doc", content: [] }));
        expect(updated.editedAt).not.toBeNull();
        const listed = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(listed).toHaveLength(1);
        yield* repo.softDelete(c.id);
        const hidden = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(hidden).toEqual([]);
      })
    ));
  });
});
```

Implementation `server/repos/comment.repo.ts` (same pattern — prepare/get/all, `RETURNING` for insert/update):

```ts
export class CommentRepo extends Effect.Service<CommentRepo>()("Lexa/CommentRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;
    const insert = (input: { taskId: string; authorId: string | null; authorKind: ActorKind; authorLabel: string; body: string }): Effect.Effect<TaskComment, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body)
           VALUES (?, ?, ?, ?, ?) RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(input.taskId, input.authorId, input.authorKind, input.authorLabel, input.body) as CommentRow;
        return rowToComment(row);
      });
    const findById = (id: number): Effect.Effect<TaskComment | null, DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `SELECT id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at
           FROM task_comments WHERE id = ?`
        ).get(id) as CommentRow | undefined;
        return row ? rowToComment(row) : null;
      });
    const updateBody = (id: number, body: string): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `UPDATE task_comments SET body = ?, edited_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
           RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(body, id) as CommentRow | undefined;
        if (!row) return yield* new RowNotFound({ table: "task_comments" });
        return rowToComment(row);
      });
    const softDelete = (id: number): Effect.Effect<TaskComment, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const row = db.prepare(
          `UPDATE task_comments SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL
           RETURNING id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at`
        ).get(id) as CommentRow | undefined;
        if (!row) return yield* new RowNotFound({ table: "task_comments" });
        return rowToComment(row);
      });
    const listByTaskKeyset = (taskId: string, cursor: { createdAt: string; id: number } | null, limit: number): Effect.Effect<TaskComment[], DbError> =>
      Effect.gen(function* () {
        const rows = db.prepare(
          `SELECT id, task_id, author_id, author_kind, author_label, body, edited_at, deleted_at, created_at
           FROM task_comments
           WHERE task_id = ? AND deleted_at IS NULL
             AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        ).all(taskId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit) as CommentRow[];
        return rows.map(rowToComment);
      });
    return { insert, findById, updateBody, softDelete, listByTaskKeyset };
  }),
}) {}
```

(Imports: add `RowNotFound` from `../db/database`; `CommentRow`, `rowToComment` from `../../shared/db`; `TaskComment`, `ActorKind` from `../../shared/types`.)

- [ ] **Step 6: Run all repo tests**

Run: `vitest run server/repos/`
Expected: PASS

---

### Task 4: Actor plumbing — key name + browser user header

**Files:**
- Modify: `server/api/auth-key.ts`, `server/api/auth.ts`, `server/api/middleware.ts`, `server/entry.ts` (~line 250 meta injection; ~line 208-217 user resolution), `app/lib/api.ts` (client sends header — frontend part of this contract)
- Test: `server/api/auth-key.test.ts` (new)

**Interfaces:**
- Consumes: `AuthIdentity` tag (`server/api/auth.ts:11`), `findOrCreateUserByIdentity(email, name, dbPath)` (`server/api/auth.ts:35`), `ApiKeyRepo.findByHash` (returns `ApiKeyRow` with `name`).
- Produces: `AuthIdentityShape` gains `keyName: string; userName: string | null; keyId: string`. `actorFromIdentity(identity): Actor` exported from `server/api/auth.ts`. HTTP header contract: client sends `x-lxk-user: <email>` (resolved server-side against users table — spoofable by API-key holders, documented; the key already grants full access).

- [ ] **Step 1: Write the failing test** — `server/api/auth-key.test.ts`

```ts
import { describe, expect, it } from "vitest";
// reuse tmp-db + migrations pattern
describe("resolveApiKeyIdentity", () => {
  it("returns keyName and resolves x-lxk-user to a user", () => {
    // seed: api_keys row (id 'k1', name 'opencode-local', key_hash of RAW), users row (u1)
    const keyHash = sha256hex(RAW_KEY);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, headersWith({ "x-lxk-user": "maria@lexa.test" }), dbPath);
    // assert res.keyName === "opencode-local", res.userId === "u1", res.userName === "Maria"
  });
});
```

(The exact function signature: extend `resolveApiKeyIdentity` in `server/api/auth-key.ts` — currently `(authHeader, db)` → `(authHeader, headers: Headers, db)` or read via a headers object. Implementer keeps call sites honest.)

- [ ] **Step 2: Run to verify it fails** — `vitest run server/api/auth-key.test.ts`
Expected: FAIL (missing fields)

- [ ] **Step 3: Implement**

`server/api/auth-key.ts` — extend the returned identity with the key's `name` and the resolved browser user:

```ts
// After key lookup (findByHash returns { id, name, user_id }):
// 1. identity = { keyId: row.id, keyName: row.name, role, userId, userName: null }
// 2. If header "x-lxk-user" present:
//      const user = findOrCreateUserByIdentity(email, emailPrefix, dbPath);
//      identity.userId = user.id; identity.userName = user.name;
//    (role NEVER changes from the header — authz stays key-based;
//     the header only enriches attribution. Spoofable by key holders:
//     accepted — the key already grants full access.)
```

`server/api/auth.ts` — add the `Actor` builder + extend the shape:

```ts
export class AuthIdentity extends Context.Tag("Lexa/AuthIdentity")<AuthIdentity, AuthIdentityShape>() {}

export interface AuthIdentityShape {
  keyId: string;
  keyName: string;
  userId: string | null;
  userName: string | null;
  role: "admin" | "member";
}

export function actorFromIdentity(identity: AuthIdentityShape): Actor {
  return {
    kind: identity.userId ? "user" : "agent",
    label: identity.userName ?? identity.keyName,
    userId: identity.userId,
  };
}
```

`server/api/middleware.ts` — pass the headers into `resolveApiKeyIdentity` and `provideService` the extended shape.

`server/entry.ts` (~line 250) — inject the resolved user into the served HTML next to the existing key meta:

```ts
`<head><meta name="lxk-api-key" content="${process.env.LXK_API_KEY}">` +
(user ? `<meta name="lxk-user" content='${JSON.stringify({ email: user.email, name: user.name })}'>` : "")
```

`app/lib/api.ts` — read both metas and send the header (frontend half):

```ts
// near the existing key read (api.ts:8-14):
const userMeta = document.querySelector<HTMLMetaElement>('meta[name="lxk-user"]')?.content;
let lxkUser: { email: string; name: string } | null = null;
try { if (userMeta) lxkUser = JSON.parse(userMeta); } catch { /* ignore malformed */ }
// in request(): headers: { ...(lxkUser ? { "x-lxk-user": lxkUser.email } : {}), ... }
```

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/api/auth-key.test.ts && tsc --noEmit`
Expected: PASS

---

### Task 5: Message catalog (pure)

**Files:**
- Create: `server/activity-messages.ts`
- Test: `server/activity-messages.test.ts`

**Interfaces:**
- Produces: pure functions, one per event type (below). Consumed by all emission points (Task 8) and CommentService (Task 7). Actor is embedded in the message where the wireframe shows it; `actor_label` is stored separately for the UI's agent tag/comment header.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import * as m from "./activity-messages";
describe("activity messages", () => {
  it("formats per type", () => {
    expect(m.created("Maria")).toBe("Maria created this task");
    expect(m.moved("Maria", "Backlog", "In Progress", null, null)).toBe("Maria moved from Backlog to In Progress");
    expect(m.moved("Maria", "Backlog", "Done", null, "Sprint 6")).toBe("Maria moved from Backlog to Done in Sprint 6");
    expect(m.priorityChanged("Medium", "High")).toBe("Priority changed: Medium → High");
    expect(m.linkAdded("subtask_of", "Auto-save on zone transition")).toBe("Linked subtask: Auto-save on zone transition");
    expect(m.linkRemoved("blocked_by", "Boss arena trigger zones")).toBe("Removed blocked-by: Boss arena trigger zones");
    expect(m.githubSynced(107, "closed", "Done")).toBe("Issue #107 closed on GitHub — task moved to Done");
    expect(m.forgeCompleted("opencode")).toBe("Forge: opencode completed — result ready");
    expect(m.commentDeleted("Maria")).toBe("Maria deleted a comment");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `vitest run server/activity-messages.test.ts`

- [ ] **Step 3: Implement `server/activity-messages.ts`**

```ts
// Message strings are frozen at write time (append-only audit trail).
// Column/lane names are captured as passed — never re-rendered later.
export function created(actor: string) { return `${actor} created this task`; }
export function moved(actor: string, fromCol: string | null, toCol: string, fromLane: string | null, toLane: string | null) {
  if (fromCol !== null && fromCol !== toCol) {
    return toLane !== null && toLane !== fromLane
      ? `${actor} moved from ${fromCol} to ${toCol} in ${toLane}`
      : `${actor} moved from ${fromCol} to ${toCol}`;
  }
  return toLane !== null && toLane !== fromLane ? `${actor} moved to ${toLane} in ${toCol}` : `${actor} moved`;
}
export function titleChanged(actor: string) { return `${actor} changed the title`; }
export function descriptionUpdated(actor: string) { return `${actor} updated the description`; }
export function priorityChanged(from: string, to: string) { return `Priority changed: ${from} → ${to}`; }
export function typeChanged(from: string, to: string) { return `Type changed: ${from} → ${to}`; }
export function assigneesUpdated(actor: string) { return `${actor} updated assignees`; }
export function archived(actor: string) { return `${actor} archived this task`; }
export function restored(actor: string) { return `${actor} restored this task`; }
export function deletedTask(actor: string) { return `${actor} deleted this task`; }
const RELATION_LABEL: Record<string, string> = { subtask_of: "subtask", blocked_by: "blocked-by", related_to: "related" };
export function linkAdded(relation: string, title: string) { return `Linked ${RELATION_LABEL[relation] ?? relation}: ${title}`; }
export function linkRemoved(relation: string, title: string) { return `Removed ${RELATION_LABEL[relation] ?? relation}: ${title}`; }
export function sourceAdded(label: string, kind: "wiki" | "url") { return `Added source: ${label}${kind === "wiki" ? " (wiki)" : ""}`; }
export function sourceRemoved(label: string) { return `Removed source: ${label}`; }
export function githubLinked(repo: string, number: number) { return `Linked GitHub issue ${repo} #${number}`; }
export function githubUnlinked(repo: string, number: number) { return `Unlinked GitHub issue ${repo} #${number}`; }
export function githubSynced(number: number, state: "open" | "closed", toCol: string) {
  return `Issue #${number} ${state} on GitHub — task moved to ${toCol}`;
}
export function forgeCompleted(agent: string) { return `Forge: ${agent} completed — result ready`; }
export function forgeFailed() { return "Forge run failed"; }
export function forgeCancelled() { return "Forge run cancelled"; }
export function commented(actor: string) { return `${actor} commented`; }
export function commentDeleted(actor: string) { return `${actor} deleted a comment`; }
```

- [ ] **Step 4: Run to verify it passes** — `vitest run server/activity-messages.test.ts`

---

### Task 6: ActivityService (append + listMerged)

**Files:**
- Create: `server/services/activity.service.ts`
- Test: `server/services/activity.service.test.ts`

**Interfaces:**
- Consumes: `ActivityRepo`, `CommentRepo`, `Sqlite`; `ActivityItem`, `Actor` types.
- Produces: `append(taskId, actor: Actor, type, message): Effect.Effect<ActivityEvent, DbError | ConstraintViolation>` — **nested-transaction-safe** (uses `batch()`, which joins the outer tx via `txDepth`); `listMerged(taskId, cursor: string | null, limit): Effect.Effect<{ items: ActivityItem[]; nextCursor: string | null }, DbError>` — merged events+comments DESC, sliced, reversed to ascending; cursor format `"<createdAt>|<id>|<kind>"`.

- [ ] **Step 1: Write the failing test** — `server/services/activity.service.test.ts` (tmp-db pattern; seed task; seed one comment via CommentRepo, one event via ActivityService)

```ts
describe("ActivityService.listMerged", () => {
  it("merges events and comments chronologically with keyset pagination", () => {
    // seed: two events + one comment (comment inserted with explicit created_at '2026-01-02', events 2026-01-01 / 2026-01-03)
    // page 1 limit 2 (ascending): [event 01-01, comment 01-02], nextCursor non-null
    // page 2: [event 01-03], nextCursor null
  });
  it("append is nested-transaction-safe", () => {
    // within withTx(db, append + throw) → rollback removes both
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement `server/services/activity.service.ts`**

```ts
import { Effect } from "effect";
import { Sqlite, batch } from "../db/database";
import { ActivityRepo } from "../repos/activity.repo";
import { CommentRepo } from "../repos/comment.repo";
import { ActivityItem, Actor, ActivityType, ActivityEvent } from "../../shared/types";

export class ActivityService extends Effect.Service<ActivityService>()("Lexa/ActivityService", {
  dependencies: [ActivityRepo.Default, CommentRepo.Default],
  effect: Effect.gen(function* () {
    const activityRepo = yield* ActivityRepo;
    const commentRepo = yield* CommentRepo;
    const db = yield* Sqlite;

    const append = (taskId: string, actor: Actor, type: ActivityType, message: string): Effect.Effect<ActivityEvent, never, never> =>
      // returns the inserted row; participates in the outer transaction when inside withTx/batch
      activityRepo.insert({
        taskId, actorKind: actor.kind, actorLabel: actor.label,
        actorUserId: actor.userId ?? null, type, message,
      }) as Effect.Effect<ActivityEvent, never, never>;

    const listMerged = (taskId: string, cursor: string | null, limit: number): Effect.Effect<{ items: ActivityItem[]; nextCursor: string | null }, never, never> =>
      Effect.gen(function* () {
        const parsed = cursor ? (() => {
          const [createdAt, idStr, kind] = cursor.split("|");
          return { createdAt, id: Number(idStr), kind: kind as "event" | "comment" };
        })() : null;
        const c = parsed ? { createdAt: parsed.createdAt, id: parsed.id } : null;
        const page = limit + 1;
        const events = yield* activityRepo.listByTaskKeyset(taskId, c, page);
        const comments = yield* commentRepo.listByTaskKeyset(taskId, c, page);
        const merged = ([] as ({ at: string; id: number; kind: "event" | "comment"; item: ActivityItem })[])
          .concat(
            events.map((e) => ({ at: e.createdAt, id: e.id, kind: "event" as const, item: { kind: "event", ...e } })),
            comments.map((cm) => ({ at: cm.createdAt, id: cm.id, kind: "comment" as const, item: { kind: "comment", ...cm } }))
          )
          .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : y.id - x.id));
        const hasMore = merged.length > limit;
        const slice = merged.slice(0, limit);
        const items = slice.map((s) => s.item).reverse(); // ascending oldest→newest
        const nextCursor = hasMore && slice.length > 0
          ? `${slice[slice.length - 1].at}|${slice[slice.length - 1].id}|${slice[slice.length - 1].kind}`
          : null;
        return { items, nextCursor };
      });

    return { append, listMerged };
  }),
}) {}
```

(If the Effect error-type gymnastics on `append` fight the compiler, type it `Effect.Effect<ActivityEvent, DbError | ConstraintViolation>` and have callers handle/ignore via `Effect.ignore` only where the mutation already has a tx error path — prefer propagating.)

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/services/activity.service.test.ts && tsc --noEmit`
Expected: PASS

---

### Task 7: CommentService (create/edit/delete + authz)

**Files:**
- Create: `server/services/comment.service.ts`
- Modify: `server/services/task.service.ts` — `export function isEmptyDoc(doc: TipTapDoc): boolean` (extract the existing TipTap-aware emptiness used by `validateRequiredFields`, lines ~147-154)
- Test: `server/services/comment.service.test.ts`

**Interfaces:**
- Consumes: `CommentRepo`, `ActivityRepo`, `TaskRepo` (existence), `UserProjectRoleRepo` (`findByUserAndProject`), `AuthIdentity` shape, errors `TaskNotFound`, `CommentNotFound`, `CommentEditForbidden`, `CommentDeleteForbidden`, `CommentInvalid` (Task 9 adds these to `errors.ts` — implementer must add them HERE first, Task 9 wires statuses).
- Produces: `CommentService.create(taskId, actor, body: TipTapDoc): Effect<{ comment: TaskComment; activity: ActivityEvent }, TaskNotFound | CommentInvalid | DbError | ConstraintViolation | RowNotFound>`; `CommentService.edit(commentId, identity, body): Effect<TaskComment, CommentNotFound | CommentEditForbidden | CommentInvalid | DbError | RowNotFound>`; `CommentService.remove(commentId, identity, projectId): Effect<{ comment: TaskComment; activity: ActivityEvent }, CommentNotFound | CommentDeleteForbidden | DbError | RowNotFound>`.

Authz rules (spec): edit = author only (`comment.authorKind === "user" && comment.authorId === identity.userId`). Delete = author OR admin (`identity.role === "admin"` OR admin `user_project_roles` row for the project). Body validation: non-empty TipTap doc (`isEmptyDoc`) and `JSON.stringify(body).length <= 65536`.

- [ ] **Step 1: Write the failing test**

```ts
describe("CommentService", () => {
  // seed: task t1 (p1), users u1 (Maria) u2 (Alex, admin role via user_project_roles row 'admin'),
  //       identity helpers: idOf = (userId) => ({ keyId: "k", keyName: "k", userId, userName: "X", role: "member" })
  it("create validates and appends activity in one tx", () => {
    // empty doc → CommentInvalid
    // valid → returns comment + activity row type 'commented', message "Maria commented"
  });
  it("edit allows only the author", () => {
    // u2 editing Maria's comment → CommentEditForbidden
    // Maria editing → editedAt set, no new activity row
  });
  it("delete allows author or admin, soft-deletes, appends comment_deleted", () => {
    // u2 (member, not admin) → CommentDeleteForbidden
    // u2 with admin project role → ok; comment.deletedAt set; activity 'comment_deleted'
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement `server/services/comment.service.ts`**

```ts
import { Effect, Data } from "effect";
import { withTx, Sqlite, RowNotFound } from "../db/database";
import { CommentRepo } from "../repos/comment.repo";
import { ActivityRepo } from "../repos/activity.repo";
import { TaskRepo } from "../repos/task.repo";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { TipTapDoc, Actor, TaskComment, ActivityEvent, ActorKind } from "../../shared/types";
import { isEmptyDoc } from "./task.service";
import * as msg from "../activity-messages";

export class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}
export class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {}
export class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {}
export class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}
const MAX_COMMENT_BYTES = 65536;

interface Identity { userId: string | null; userName: string | null; role: "admin" | "member"; }

export class CommentService extends Effect.Service<CommentService>()("Lexa/CommentService", {
  dependencies: [CommentRepo.Default, ActivityRepo.Default, TaskRepo.Default, UserProjectRoleRepo.Default],
  effect: Effect.gen(function* () {
    const commentRepo = yield* CommentRepo;
    const activityRepo = yield* ActivityRepo;
    const taskRepo = yield* TaskRepo;
    const roleRepo = yield* UserProjectRoleRepo;
    const db = yield* Sqlite;

    const validateBody = (body: TipTapDoc): Effect.Effect<void, CommentInvalid> =>
      Effect.gen(function* () {
        if (!body || typeof body !== "object" || body.type !== "doc") {
          return yield* new CommentInvalid({ reason: "body must be a TipTap doc" });
        }
        if (isEmptyDoc(body)) return yield* new CommentInvalid({ reason: "comment body is empty" });
        if (JSON.stringify(body).length > MAX_COMMENT_BYTES) {
          return yield* new CommentInvalid({ reason: "comment body exceeds 64KB" });
        }
      });

    const create = (taskId: string, actor: Actor, body: TipTapDoc): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, CommentInvalid | RowNotFound | DbError | ConstraintViolation, never> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        yield* taskRepo.findById(taskId).pipe(
          Effect.catchTag("RowNotFound", () => new RowNotFound({ table: "tasks" }))
        );
        const result = yield* withTx(db, Effect.gen(function* () {
          const comment = yield* commentRepo.insert({
            taskId, authorId: actor.userId ?? null, authorKind: actor.kind as ActorKind,
            authorLabel: actor.label, body: JSON.stringify(body),
          });
          const activity = yield* activityRepo.insert({
            taskId, actorKind: actor.kind, actorLabel: actor.label,
            actorUserId: actor.userId ?? null, type: "commented", message: msg.commented(actor.label),
          });
          return { comment, activity };
        }));
        return result;
      });

    const isProjectAdmin = (identity: Identity, projectId: string): Effect.Effect<boolean, never, never> =>
      Effect.gen(function* () {
        if (identity.role === "admin") return true;
        if (!identity.userId) return false;
        const mapping = yield* roleRepo.findByUserAndProject(identity.userId, projectId).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        );
        return mapping?.role === "admin";
      });

    const edit = (commentId: number, identity: Identity, body: TipTapDoc): Effect.Effect<TaskComment, CommentNotFound | CommentEditForbidden | CommentInvalid | DbError | RowNotFound, never> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        if (comment.authorKind !== "user" || comment.authorId !== identity.userId) {
          return yield* new CommentEditForbidden({ id: commentId });
        }
        return yield* commentRepo.updateBody(commentId, JSON.stringify(body)).pipe(
          Effect.catchTag("RowNotFound", () => new CommentNotFound({ id: commentId }))
        );
      });

    const remove = (commentId: number, identity: Identity, projectId: string): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, CommentNotFound | CommentDeleteForbidden | DbError | RowNotFound, never> =>
      Effect.gen(function* () {
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        const admin = yield* isProjectAdmin(identity, projectId);
        const author = comment.authorKind === "user" && comment.authorId === identity.userId;
        if (!author && !admin) return yield* new CommentDeleteForbidden({ id: commentId });
        return yield* withTx(db, Effect.gen(function* () {
          const removed = yield* commentRepo.softDelete(commentId).pipe(
            Effect.catchTag("RowNotFound", () => new CommentNotFound({ id: commentId }))
          );
          const activity = yield* activityRepo.insert({
            taskId: removed.taskId, actorKind: identity.userId ? "user" : "agent",
            actorLabel: identity.userName ?? "unknown", actorUserId: identity.userId,
            type: "comment_deleted", message: msg.commentDeleted(identity.userName ?? "unknown"),
          });
          return { comment: removed, activity };
        }));
      });

    return { create, edit, remove, isProjectAdmin };
  }),
}) {}
```

Notes for the implementer: `Identity` above is `AuthIdentityShape` (import from `../api/auth`); `userName` is part of the shape from Task 4. The `never` in the error channel of `withTx` bodies may need `Effect.gen` typing adjusted to the actual union — keep the return unions listed in the Interfaces block.

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/services/comment.service.test.ts && tsc --noEmit`
Expected: PASS

---

### Task 8: Emission points (the invariant)

**Files:**
- Modify: `server/services/task.service.ts` (create/update/move/archive/restore/delete + `moveFromWebhook`)
- Modify: `server/services/task-link.service.ts` (`add`, `remove`)
- Modify: `server/services/source.service.ts` (`add`, `remove`)
- Modify: `server/services/github.service.ts` (`createLinkedIssue`, the unlink path — find via grep `unlink` in `server/api/http.ts` if it lives in the handler; if so, emit there via ActivityService and note the deviation)
- Modify: `server/services/forge.service.ts` (`complete`, `fail`, `cancel`)
- Test: `server/services/task.service.test.ts` (new — emission assertions)

**Interfaces:**
- Consumes: `ActivityService.append` (Task 6), message builders (Task 5), `Actor` (Task 2/4).
- Produces: TaskService mutators gain `actor: Actor` as their FIRST parameter and (except `delete`) return `{ ...result, activity: ActivityEvent[] }` where `result` is today's return. `moveFromWebhook` emits internally (actor `{kind:'system', label:'github'}`) and keeps its `Task` return. Forge terminal methods emit internally (actor `{kind:'agent', label: <agent name>}`). **This return-shape change is consumed by Task 11 (envelope) and by the MCP tools adapted there.**

- [ ] **Step 1: Write the failing test** — `server/services/task.service.test.ts`

```ts
describe("TaskService emission", () => {
  // seed p1 + columns Todo/Done + swimlane Default + task t1 (Todo)
  it("update emits field_changed rows for each changed field", () => {
    // update title + priority → 2 activity rows: "Maria changed the title", "Priority changed: Medium → High"
    // (actor passed into update)
  });
  it("move emits moved with old/new column names", () => {
    // move t1 Todo → Done → message "Maria moved from Todo to Done"
    // reorder within same column → NO activity row
  });
  it("moveFromWebhook emits github_synced, not moved", () => {
    // moveFromWebhook → single row type 'github_synced', message "Issue #7 closed on GitHub — task moved to Done"
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement — TaskService**

Pattern for each mutator (concrete for `update`; apply the same shape to the rest):

```ts
update: (actor: Actor, id: string, input: {...}): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, ...> =>
  Effect.gen(function* () {
    // 1. read current task (needed for diffs)
    // 2. yield* current validation logic unchanged
    // 3. const task = yield* withTx(db, doUpdate...)
    // 4. build rows: e.g.
    const rows: { type: ActivityType; message: string }[] = [];
    if (input.title !== undefined && input.title !== current.title) rows.push({ type: "field_changed", message: msg.titleChanged(actor.label) });
    if (input.description !== undefined && !deepEq(input.description, current.description)) rows.push({ type: "field_changed", message: msg.descriptionUpdated(actor.label) });
    if (input.priority !== undefined && input.priority !== current.priority) rows.push({ type: "field_changed", message: msg.priorityChanged(current.priority, input.priority) });
    if (input.type !== undefined && input.type !== current.type) rows.push({ type: "field_changed", message: msg.typeChanged(current.type, input.type) });
    if (input.assignees !== undefined && !sameSet(input.assignees, current.assignees)) rows.push({ type: "field_changed", message: msg.assigneesUpdated(actor.label) });
    // 5. append rows in the SAME transaction (withTx already open → batch participates):
    const activity: ActivityEvent[] = [];
    for (const r of rows) {
      const ev = yield* activityService.append(task.id, actor, r.type, r.message);
      activity.push(ev);
    }
    return { task, activity };
  });
```

`move`: read old task → run existing move → if `task.columnId !== old.columnId || task.swimlaneId !== old.swimlaneId` (fetch column + swimlane names via `ColumnRepo.findById` / `SwimlaneRepo.findById` before/after), append `moved` inside the same `withTx`. Position-only reorders: skip emission.

`moveFromWebhook`: inside the existing `withTx` (after `taskRepo.moveFromWebhook`), append `github_synced` — message `msg.githubSynced(issueNumber, incomingState, newColumnName)`, actor `{ kind: "system", label: "github" }`. Requires the new column name (look up via `ColumnRepo.findById(target.columnId)`).

`archive`/`restore`: append `archived`/`restored` in the same tx. `delete`: append `deleted` (return stays as-is; the row is written even though the task vanishes — history of the deletion is preserved until cascade cleanup).

- [ ] **Step 4: task-link / source / github / forge services** — same pattern:

```ts
// task-link.service.ts add: after creating the link, append link_added —
//   message: msg.linkAdded(input.relation, <other task title via TaskRepo.findById>), actor param added.
// task-link.service.ts remove: append link_removed (fetch the link + other task title BEFORE deleting).
// source.service.ts add: if documentType === "task", append source_added —
//   label = wiki page title (look up) or the URL; kind "wiki" | "url".
// source.service.ts remove: same, source_removed.
// github.service.ts createLinkedIssue: append github_linked (repo + issue number from the created issue).
//   unlink: find the path (grep "unlink" in server/api/http.ts); if handler-level, emit there with
//   actorFromIdentity(AuthIdentity) — one documented exception to "services only".
// forge.service.ts complete/fail/cancel: load the forge task row (forge repo byId); if
//   document_type === "task": append forge_completed/failed/cancelled — message
//   msg.forgeCompleted(<agent name — look up forge_agents by agent_id, fallback agent_id>),
//   actor { kind: "agent", label: <agent name> }.
```

- [ ] **Step 5: Run all tests + typecheck**

Run: `vitest run server/services/ && tsc --noEmit`
Expected: PASS

---

### Task 9: Error catalog + REST activity read endpoint

**Files:**
- Modify: `server/api/errors.ts` (4 error classes + `errorToStatus` mapping)
- Modify: `server/api/http.ts` (schemas + `GET .../activity` endpoint + handler)
- Test: `server/api/errors.test.ts` (extend), `server/api/activity.test.ts` (new — handler-level via `createApiHandler`)

**Interfaces:**
- Consumes: `ActivityService.listMerged` (Task 6), `formatTask` (exists), `createApiHandler` (exists, `server/api/http.ts:2224`).
- Produces: `GET /api/projects/:slug/tasks/:id/activity?cursor&limit` → `200 { data: ActivityItem[], nextCursor: string | null }`. Schemas `ActivityEventSchema`, `TaskCommentSchema`, `ActivityItemSchema` (shared by Task 10/11). Errors: `CommentNotFound` 404, `CommentEditForbidden` 403, `CommentDeleteForbidden` 403, `CommentInvalid` 422 (map by `_tag` in `errorToStatus`).

- [ ] **Step 1: Write the failing test** — `server/api/activity.test.ts`

```ts
// pattern: server/mcp/server.test.ts fixture style, but using createApiHandler(dbPath)
// fixtures: project p1, columns, swimlane, task t1, one comment + one event
describe("GET /api/projects/:slug/tasks/:id/activity", () => {
  it("returns merged timeline with cursor", async () => {
    const handler = createApiHandler(path);
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/activity?limit=1", {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(["event", "comment"]).toContain(body.data[0].kind);
    expect(body.nextCursor).toBeTruthy();
  });
  it("rejects without a key", async () => {
    // no authorization header → 401
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

`server/api/errors.ts` — add the four classes (pattern of existing `Data.TaggedError` entries) and extend `errorToStatus`:

```ts
export class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}          // → 404
export class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {} // → 403
export class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {} // → 403
export class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}        // → 422
```

(Import these from `server/services/comment.service.ts` — the classes live there, per the existing pattern where service domain errors are imported into errors.ts for mapping. If the codebase instead declares domain errors in errors.ts, move them there and re-import in the service.)

`server/api/http.ts` — schemas (near the other task schemas; match the description-field schema used by `CreateTaskPayload` for `body`):

```ts
const ActivityEventSchema = Schema.Struct({
  kind: Schema.Literal("event"),
  id: Schema.Number,
  actorKind: Schema.Literal("user", "agent", "system"),
  actorLabel: Schema.String,
  actorUserId: Schema.NullOr(Schema.String),
  type: Schema.Literal("created", "moved", "field_changed", "archived", "restored", "deleted",
    "link_added", "link_removed", "source_added", "source_removed",
    "github_linked", "github_unlinked", "github_synced",
    "forge_completed", "forge_failed", "forge_cancelled",
    "commented", "comment_deleted"),
  message: Schema.String,
  createdAt: Schema.String,
});
const TaskCommentSchema = Schema.Struct({
  kind: Schema.Literal("comment"),
  id: Schema.Number,
  authorId: Schema.NullOr(Schema.String),
  authorKind: Schema.Literal("user", "agent", "system"),
  authorLabel: Schema.String,
  body: <same schema as CreateTaskPayload's description field>,
  editedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
const ActivityItemSchema = Schema.Union(ActivityEventSchema, TaskCommentSchema);
const ActivityPageSchema = Schema.Struct({ data: Schema.Array(ActivityItemSchema), nextCursor: Schema.NullOr(Schema.String) });
```

Endpoint + handler in `tasksGroup`:

```ts
.add(HttpApiEndpoint.get("taskActivity", "/projects/:slug/tasks/:id/activity")
  .setPath(SlugIdPath)  // match existing task path params shape
  .setQuery(Schema.Struct({ cursor: Schema.optionalWith(Schema.String, { as: "Option" }), limit: Schema.optionalWith(Schema.Number, { as: "Option" }) }))
  .addSuccess(ActivityPageSchema))
// handler:
.handle("taskActivity", (req) =>
  respond(Effect.gen(function* () {
    const projectService = yield* ProjectService;
    const activityService = yield* ActivityService;
    yield* projectService.findBySlug(req.path.slug);   // 404 for unknown project
    const limit = Math.min(req.query.limit ?? 50, 200);
    const page = yield* activityService.listMerged(req.path.id, req.query.cursor ?? null, limit);
    return page;
  }))
)
```

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/api/activity.test.ts server/api/errors.test.ts && tsc --noEmit`
Expected: PASS

---

### Task 10: REST comment endpoints

**Files:**
- Modify: `server/api/http.ts` (3 endpoints + schemas + authz wiring)
- Test: `server/api/comment.test.ts` (new)

**Interfaces:**
- Consumes: `CommentService.create/edit/remove`, `actorFromIdentity` (Task 4), `AuthIdentity` (Task 4).
- Produces: `POST /projects/:slug/tasks/:id/comments` `{ body }` → `201 { data: { comment: TaskCommentSchema, activity: ActivityEventSchema } }`; `PATCH /projects/:slug/tasks/:id/comments/:commentId` `{ body }` → `200 { data: TaskCommentSchema }`; `DELETE .../comments/:commentId` → `204`.

- [ ] **Step 1: Write the failing test** — `server/api/comment.test.ts`

```ts
// fixtures: project p1, task t1, users u1(Maria) u2(Alex admin), comments row by u1
// identity: requests carry `x-lxk-user: maria@lexa.test` (or alex@...) + Bearer ADMIN_KEY
describe("comment endpoints", () => {
  it("create → 201 with comment + activity; invalid body → 422", async () => {
    const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1/comments", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] } }),
    }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.comment.authorLabel).toBe("Maria");
    expect(data.activity.type).toBe("commented");
  });
  it("edit by non-author → 403", async () => {
    // PATCH with x-lxk-user: alex@lexa.test → 403, code COMMENT_EDIT_FORBIDDEN
  });
  it("delete by non-author non-admin → 403; admin → 204", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement** — add to `tasksGroup`:

```ts
.add(HttpApiEndpoint.post("createComment", "/projects/:slug/tasks/:id/comments")
  .setPath(SlugIdPath).setPayload(CommentPayloadSchema).addSuccess(CommentCreateResponseSchema, { status: 201 }))
.add(HttpApiEndpoint.patch("updateComment", "/projects/:slug/tasks/:id/comments/:commentId")
  .setPath(CommentIdPath).setPayload(CommentPayloadSchema).addSuccess(TaskCommentSchema))
.add(HttpApiEndpoint.del("deleteComment", "/projects/:slug/tasks/:id/comments/:commentId")
  .setPath(CommentIdPath).addSuccess(Schema.Void, { status: 204 }))
```

Handlers (pattern):

```ts
.handle("createComment", (req) =>
  respond(Effect.gen(function* () {
    const identity = yield* AuthIdentity;
    const commentService = yield* CommentService;
    const projectService = yield* ProjectService;
    yield* projectService.findBySlug(req.path.slug);
    const result = yield* commentService.create(req.path.id, actorFromIdentity(identity), req.payload.body);
    return result;
  }))
)
// updateComment: edit(req.path.commentId, identity, req.payload.body)
// deleteComment: commentService.remove(req.path.commentId, identity, <projectId — resolve via taskRepo.findById(req.path.id) first>);
//   then return void (204)
```

`CommentIdPath` = `Schema.Struct({ slug: ..., id: ..., commentId: Schema.NumberFromString })` (match the existing path-schema conventions in http.ts).

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/api/comment.test.ts && tsc --noEmit`
Expected: PASS

---

### Task 11: Response envelope (activity[] on task mutation responses)

**Files:**
- Modify: `server/api/http.ts` (mutation success schemas + handlers)
- Modify: `server/mcp/tools/create-task.ts`, `update-task.ts`, `move-task.ts`, `archive-task.ts`, `restore-task.ts` (adapt to `{ task, activity }` returns — `const { task } = yield* taskService.create(...)`)
- Modify: `app/lib/api.ts` types (client response types gain `activity`)

**Interfaces:**
- Consumes: TaskService mutator return shapes (Task 8), `ActivityEventSchema` (Task 9).
- Produces: mutation responses `{ data: TaskSchema, activity: ActivityEventSchema[] }` for: createTask (201), updateTask, moveTask, archiveTask, restoreTask; same envelope for link add/remove, source add/remove, github link/unlink (their services return the appended rows per Task 8; wrap the existing primary payload). `deleteTask` and comment delete stay `204` (no body — documented deviation; the client drops the timeline cache for deleted tasks). Comment create/delete keep their Task 10 shapes.

- [ ] **Step 1: Write the failing test** — extend `server/api/activity.test.ts`

```ts
it("updateTask response carries the appended activity", async () => {
  const res = await handler(new Request("http://lexa.test/api/projects/p1/tasks/t1", {
    method: "PATCH",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
    body: JSON.stringify({ title: "New title" }),
  }));
  expect(res.status).toBe(200);
  const { data, activity } = await res.json();
  expect(data.title).toBe("New title");
  expect(activity).toHaveLength(1);
  expect(activity[0].message).toBe("Maria changed the title");
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

For each endpoint listed in Interfaces: change the success schema to `Schema.Struct({ data: <existing>, activity: Schema.Array(ActivityEventSchema) })` and the handler to `const { ...primary, activity } = yield* ...; return { ...primary, activity };`. For link/source/github endpoints: their services return `{ primary, activity }` per Task 8; handlers spread both.

Adapt the five MCP tools: destructure `const { task } = yield* taskService.update(...)` (etc.) and keep building the existing summaries from `task`.

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/ && tsc --noEmit`
Expected: PASS

---

### Task 12: MCP tools

**Files:**
- Modify: `server/mcp/server.ts` (authContext gains `keyName`)
- Create: `server/mcp/tools/get-task-activity.ts`, `server/mcp/tools/add-task-comment.ts`
- Modify: `server/mcp/tools/index.ts` (or wherever `tools` array is assembled — `server.ts:68-104`)
- Test: `server/mcp/activity.test.ts` (new — `createMcpHandler` pattern)

**Interfaces:**
- Consumes: `ActivityService.listMerged`, `CommentService.create`, `docToMarkdown`/`markdownToDoc`, `ApiKeyRepo.findByHash` (has `name`).
- Produces: tool `get_task_activity` `{ taskId }` → `{ activity: [{ type, actor, at, message, comment?: { markdown } }], nextCursor? }`; tool `add_task_comment` `{ taskId, comment: Markdown }` → created comment (Markdown body). Tool handler auth param gains `keyName`.

- [ ] **Step 1: Write the failing test** — `server/mcp/activity.test.ts` (fixtures per `server.test.ts`; seed task + one comment)

```ts
describe("MCP activity tools", () => {
  it("get_task_activity returns Markdown timeline", async () => {
    const res = await call("get_task_activity", { taskId: "t1" }, ADMIN_KEY);
    expect(res.result).toBeDefined();
    const { activity } = res.result;
    expect(activity.some((a: any) => a.message.includes("created this task"))).toBe(true);
    const c = activity.find((a: any) => a.comment);
    expect(c.comment.markdown).toContain("hi");
  });
  it("add_task_comment converts Markdown and attributes the key", async () => {
    const res = await call("add_task_comment", { taskId: "t1", comment: "**bold** note" }, ADMIN_KEY);
    expect(res.result.authorLabel).toBe("admin");          // ADMIN_KEY row name
    const list = await call("get_task_activity", { taskId: "t1" }, ADMIN_KEY);
    expect(list.result.activity.at(-1).message).toBe("admin commented");
  });
  it("rejects empty comment", async () => {
    const res = await call("add_task_comment", { taskId: "t1", comment: "" }, ADMIN_KEY);
    expect(res.error.code).toBe("COMMENT_INVALID");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement**

`server/mcp/server.ts` — in `checkAuth` (`server.ts:168-190`), include `keyName: row.name` in the returned authContext and thread it into `tool.handler(args, { userId, role, keyName })`. Keep the existing `{ userId, role }` fields intact.

`server/mcp/tools/get-task-activity.ts`:

```ts
import { Effect } from "effect";
import { ActivityService } from "../../services/activity.service";
import { docToMarkdown } from "../../../shared/markdown";

export const tool = {
  name: "get_task_activity",
  description: "Read the activity timeline for a task (UUID): system events (moves, field changes, links, GitHub sync, Forge runs) and comments, oldest first. Comments are serialized as Markdown. Returns the same page as the REST endpoint; pass nextCursor for older entries.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      cursor: { type: "string", description: "Opaque pagination cursor (from a previous response)", },
    },
    required: ["taskId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const activityService = yield* ActivityService;
      const page = yield* activityService.listMerged(args.taskId, args.cursor ?? null, 50);
      return {
        activity: page.items.map((it) =>
          it.kind === "event"
            ? { type: it.type, actor: it.actorKind === "agent" ? `${it.actorLabel} (agent)` : it.actorLabel, at: it.createdAt, message: it.message }
            : { type: "comment", actor: it.authorLabel, at: it.createdAt, message: it.authorLabel, comment: { markdown: docToMarkdown(it.body) } }
        ),
        nextCursor: page.nextCursor,
      };
    }),
};
```

`server/mcp/tools/add-task-comment.ts`:

```ts
export const tool = {
  name: "add_task_comment",
  description: "Post a comment on a task (UUID). The comment is Markdown; it is stored as rich text and rendered in the Lexa UI. The agent's API key name is recorded as the author.",
  inputSchema: { type: "object", properties: { taskId: { type: "string" }, comment: { type: "string", description: "Markdown comment body (non-empty)" } }, required: ["taskId", "comment"] },
  handler: (args: any, auth?: { userId: string | null; role: string; keyName: string }) =>
    Effect.gen(function* () {
      const commentService = yield* CommentService;
      const actor = { kind: "agent" as const, label: auth?.keyName ?? "agent", userId: auth?.userId ?? null };
      const result = yield* commentService.create(args.taskId, actor, markdownToDoc(args.comment)).pipe(
        Effect.mapError((e) => ({ code: e._tag === "CommentInvalid" ? "COMMENT_INVALID" : e._tag === "RowNotFound" ? "TASK_NOT_FOUND" : "INTERNAL_ERROR", message: e._tag, details: {} }))
      );
      return { id: result.comment.id, authorLabel: result.comment.authorLabel, body: docToMarkdown(result.comment.body), createdAt: result.comment.createdAt };
    }),
};
```

(Register both in the tools array. `Effect.mapError` on a `Data.TaggedError` union: match `_tag` — see `buildToolError` in `server.ts:126-143` for the existing mapping convention and prefer it if cleaner.)

- [ ] **Step 4: Run to verify it passes**

Run: `vitest run server/mcp/ && tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Update `docs/MCP.md`** — add both tools verbatim from the spec §MCP (shapes + errors), and note agents have no comment edit/delete tools.

---

### Task 13: Frontend API client

**Files:**
- Modify: `app/lib/api.ts` (activity/comment calls + `x-lxk-user` header — the header half is Task 4; the calls here)
- Modify: `app/lib/api.ts` types (import `ActivityItem`, `TaskComment` from shared)

**Interfaces:**
- Consumes: `request<T>` wrapper (api.ts:16-32), shared types (Task 2).
- Produces: `getTaskActivity(slug, taskId, cursor?): Promise<{ data: ActivityItem[]; nextCursor: string | null }>`; `createComment(slug, taskId, body: TipTapDoc): Promise<{ comment: TaskComment; activity: ActivityEvent }>`; `updateComment(slug, taskId, commentId, body): Promise<TaskComment>`; `deleteComment(slug, taskId, commentId): Promise<void>`. Existing task mutation types gain optional `activity?: ActivityEvent[]` on their responses (used by Task 14).

- [ ] **Step 1: Implement** (small, type-checked by Task 14's consumers)

```ts
// app/lib/api.ts
export interface ActivityPage { data: ActivityItem[]; nextCursor: string | null }
getTaskActivity: (slug: string, taskId: string, cursor?: string) =>
  request<ActivityPage>(`/api/projects/${slug}/tasks/${taskId}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
createComment: (slug: string, taskId: string, body: TipTapDoc) =>
  request<{ comment: TaskComment; activity: ActivityEvent }>(`/api/projects/${slug}/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
updateComment: (slug: string, taskId: string, commentId: number, body: TipTapDoc) =>
  request<TaskComment>(`/api/projects/${slug}/tasks/${taskId}/comments/${commentId}`, { method: "PATCH", body: JSON.stringify({ body }) }),
deleteComment: (slug: string, taskId: string, commentId: number) =>
  request<void>(`/api/projects/${slug}/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" }),
```

- [ ] **Step 2: Verify** — `tsc --noEmit`

---

### Task 14: Frontend query hooks + cache discipline

**Files:**
- Modify: `app/lib/queries.ts`

**Interfaces:**
- Consumes: api.ts calls (Task 13), existing hook patterns (recon: `useUpdateTask` at queries.ts:110, `useMoveTask` :155, `useArchiveTask` :203, `useRestoreTask` :227, `useLinkGithubIssue` :271, `useUnlinkGithubIssue` :287, link/source hooks ~:890-990).
- Produces: `useTaskActivity(slug, taskId)` (useInfiniteQuery, key `["task-activity", slug, taskId]`, `getNextPageParam: (last) => last.nextCursor`, `initialPageParam: null`, pages ascending); `useAddComment(slug, taskId)`, `useUpdateComment(slug, taskId)`, `useDeleteComment(slug, taskId)`; exported helper `prependActivity(qc, slug, taskId, items: ActivityItem[])`; envelope consumption in the existing task mutations.

- [ ] **Step 1: Implement the activity query + comment mutations**

```ts
export function useTaskActivity(slug: string, taskId: string) {
  return useInfiniteQuery({
    queryKey: ["task-activity", slug, taskId],
    queryFn: ({ pageParam }) => api.getTaskActivity(slug, taskId, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function prependActivity(qc: QueryClient, slug: string, taskId: string, items: ActivityItem[]) {
  qc.setQueryData<InfiniteData<ActivityPage>>(["task-activity", slug, taskId], (old) => {
    if (!old) return old;
    return { ...old, pages: old.pages.map((p, i) => (i === 0 ? { ...p, data: [...items, ...p.data] } : p)) };
  });
}

export function useAddComment(slug: string, taskId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: TipTapDoc) => api.createComment(slug, taskId, body),
    onSuccess: (result) => {
      prependActivity(qc, slug, taskId, [
        { kind: "comment", ...result.comment },
        { kind: "event", ...result.activity },
      ]);
    },
    onError: (err) => { toast.push("error", "Failed to add comment", toastMessage(err)); },
  });
}
// useUpdateComment: PATCH → setQueryData(["task-activity", slug, taskId], replace the comment item by id)
// useDeleteComment: DELETE → prependActivity(qc, slug, taskId, [{ kind: "event", ...activity }])
//   (deleteComment returns 204 — the client removes the comment card from the cache AND prepends
//    a local event row: { kind: "event", id: -Date.now(), type: "comment_deleted",
//    actorKind: "user", actorLabel: <current user name>, message: "<user> deleted a comment", createdAt: now }.
//    A refetch on next open replaces it with the server row. Documented.)
```

- [ ] **Step 2: Envelope consumption in existing mutations**

In each of these `onSuccess` handlers, prepend `task.activity` (when present) — exact pattern for `useUpdateTask`; same line in `useMoveTask`, `useArchiveTask`, `useRestoreTask`, `useCreateTask`, `useLinkGithubIssue`, `useUnlinkGithubIssue`, and the link/source mutation hooks (~queries.ts:890-990):

```ts
onSuccess: (task) => {
  // ...existing setQueryData calls unchanged...
  if (task.activity?.length) prependActivity(qc, slug, task.id, task.activity.map((a) => ({ kind: "event", ...a })));
},
```

`useDeleteTask` onSuccess: `qc.removeQueries({ queryKey: ["task-activity", slug, taskId] })`.

- [ ] **Step 3: Verify** — `tsc --noEmit`

---

### Task 15: Activity tab UI (designer-executed)

**Files:**
- Create: `app/components/activity/ActivityTab.tsx`, `ActivityTimeline.tsx`, `CommentCard.tsx`, `CommentComposer.tsx`, `CommentBody.tsx` (or a single `ActivityTab.tsx` if cleaner)
- Modify: `app/components/TaskDetail.tsx` (tab bar between line 299 and 303; `useState<"description" | "activity">("description")`; render the existing `slideover-body` content under the Description tab, `ActivityTab` under Activity)
- Modify: `app/components/layout/UserProfile.tsx` (identity — see Task 17, do it here if the designer touches it)
- Modify: `app/routes/$slug/index.tsx` (nothing structural — verify slideover props flow)

**Interfaces:**
- Consumes: `useTaskActivity` + comment mutations (Task 14), `useProjectMembers` (queries.ts:563), `renderDoc` (tiptap-render.tsx), `TextEditor` (TextEditor.tsx:201, for the composer), wireframe `wireframes/src/task-detail.html` (source of truth — step rail, event rows, comment cards, agent tags, composer, empty state, archived view-only).
- Produces: the tabbed slideover per the wireframe.

- [ ] **Step 1: Transcribe the wireframe** — the Activity tab markup, step rail (markers = event dots/avatars on one 24px rail column; rail bounds derived from marker positions — implement with a `position: relative` timeline and per-row rail segments or an absolutely positioned rail computed from marker offsets; the wireframe uses hardcoded bounds, P5 must derive them), event rows (message as **plain text** — XSS rule; agent rows show the agent tag + key-owner hint "(X's key)" when `actorUserId` present), comment cards (avatar, author, time, `edited` marker when `editedAt`, Edit/Delete hover actions — author sees both, admin sees Delete only), deleted-comment collapse (no card — only the `comment_deleted` event row), Load-older (calls `fetchNextPage`), empty state ("No activity yet — be the first to comment"), composer (trimmed toolbar per wireframe: bold/italic/bullet/link/code — reuse `TextEditor` with a trimmed `Toolbar` or inline buttons; Enter to comment, Shift+Enter newline; disabled while empty; hidden on archived tasks with the muted notice "Comments are disabled on archived tasks").
- [ ] **Step 2: Tab bar** — segmented control matching the wireframe (`Description` / `Activity`); Description tab renders the current `slideover-body` content unchanged; default tab on open = Description.
- [ ] **Step 3: Mention highlight** — `CommentBody` walks the comment TipTap doc (reuse the exported `renderNode`/`renderInline` from `tiptap-render.tsx`), wrapping `@Name` text matching project member names (`useProjectMembers(slug)`) in `<span className="mention-chip">`; unknown names render plain. (Task 16 owns the renderer; Task 15 owns the components that use it.)
- [ ] **Step 4: Verify** — `tsc --noEmit` + `bun run dev:full` manual pass + `agent-browser` snapshot of the slideover (console errors = 0).

---

### Task 16: Mention renderer

**Files:**
- Create: `app/lib/mention.tsx` (or `app/components/activity/CommentBody.tsx` if Task 15 already created it — coordinate; mention logic lives here)

**Interfaces:**
- Consumes: `renderNode`/`renderInline` (tiptap-render.tsx:53, :20), project member names.
- Produces: `renderCommentBody(doc: TipTapDoc, memberNames: string[]): ReactNode`.

- [ ] **Step 1: Implement**

```tsx
// app/lib/mention.tsx
import { renderInline, renderNode } from "../components/tiptap-render";

export function renderCommentBody(doc: TipTapDoc, memberNames: string[]): ReactNode {
  // Walk doc.content recursively (mirror renderNode's structure), and in text nodes
  // split on /\B@([A-Za-z][\w .-]*)/ — if the captured name (trimmed) is in memberNames,
  // wrap in <span className="mention-chip">@Name</span>, else render the raw text.
  // Use renderNode for non-text nodes unchanged.
}
```

- [ ] **Step 2: Unit test** — `app/lib/mention.test.tsx` (vitest, renderToStaticMarkup):

```tsx
it("wraps known member names, leaves unknown names plain", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ping @Maria Kim and @Ghost" }] }] } as TipTapDoc;
  const html = renderToStaticMarkup(<>{renderCommentBody(doc, ["Maria Kim"])}</>);
  expect(html).toContain('class="mention-chip"');
  expect(html).not.toContain("mention-chip\">@Ghost");  // unknown name not wrapped
});
```

- [ ] **Step 3: Verify** — `vitest run app/lib/mention.test.tsx && tsc --noEmit`

---

### Task 17: UserProfile real identity

**Files:**
- Modify: `app/components/layout/UserProfile.tsx` (drop the hardcoded `USER` placeholder, lines 4-6)
- Modify: `app/lib/api.ts` (already done in Task 4 — verify the meta read)

**Interfaces:**
- Consumes: `lxk-user` meta (Task 4 server side).
- Produces: navbar shows the real Cf-Access user name/initial; fallback to the placeholder when the meta is absent (local dev without Access).

- [ ] **Step 1: Implement**

```tsx
// replace the hardcoded USER with:
export const CURRENT_USER: { name: string; email: string } | null = (() => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="lxk-user"]')?.content;
  try { return meta ? (JSON.parse(meta) as { name: string; email: string }) : null; } catch { return null; }
})();
// UserProfile falls back to { name: "You", email: "" } when CURRENT_USER is null.
```

- [ ] **Step 2: Verify** — `tsc --noEmit` + browser pass (navbar shows the Access user on prod-shaped runs; placeholder in dev).

---

### Task 18: Docs + acceptance

**Files:**
- Modify: `docs/SCHEMA.md` (Task 1 did the schema — verify), `docs/API.md`, `docs/MCP.md` (Task 12), `docs/LAYERS.md`, `docs/ARCHITECTURE.md`, `docs/RELEASE_NOTES.md`, `AGENTS.md`, `docs/specs/ACTIVITY_COMMENTS.md` (mark implemented)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: LAYERS.md** — add `ActivityService`, `CommentService` to the service catalog (dependencies, error surfaces: `CommentNotFound`, `CommentEditForbidden`, `CommentDeleteForbidden`, `CommentInvalid`); document the emission invariant: *every task mutation appends task_activity row(s) in the same transaction as the mutation; one row per meaningful change (updates may emit several field_changed rows); position-only reorders emit nothing; webhook moves emit `github_synced` only*; document actor resolution (browser `x-lxk-user` → users table, spoofable by key holders — accepted; MCP key name; webhook `github`; forge agent name).
- [ ] **Step 2: API.md** — add the four endpoints verbatim from the spec (§REST), the envelope rule, error codes.
- [ ] **Step 3: AGENTS.md** — add the emission invariant line to the architectural invariants list.
- [ ] **Step 4: ARCHITECTURE.md** — decisions-log entry (reverses the v1 no-comments cut; actor model; spoofing tradeoff; forge accept/reject dropped — client-side only).
- [ ] **Step 5: RELEASE_NOTES.md** — add the feature to "What's new"; update the "no comments" note.
- [ ] **Step 6: Acceptance** — run the release gates in `docs/RELEASE.md` (backend curl suite incl. new endpoints, MCP handshake + new tools, frontend browser pass with 0 console errors, `tsc --noEmit`, `vitest run`) and paste outputs; mark `docs/specs/ACTIVITY_COMMENTS.md` as implemented.
