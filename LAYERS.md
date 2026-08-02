# Effect-TS Layer Architecture (v2 — post-review)

> Reviewed against REVIEW.md. Changes from v1: **circular dependency eliminated** (TaskService no longer depends on GitHubService — routes orchestrate Lexa→GitHub sync), **PolicyService removed** (folded into TaskService as a pure function — only `required_fields` survived the review), **atomic move + WIP enforcement**, **webhook idempotency + echo suppression**, **HttpApi with declarative error mapping**, **Cloudflare Access auth**, pagination, corrected code snippets.

## Layer Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│              API / MCP / Webhook Layer                   │
│  HttpApi routes (projects, columns, swimlanes, tasks,   │
│  wiki, settings)   McpServer   GitHubWebhookRoute       │
│                                                         │
│  Orchestration lives HERE: TasksRoute calls             │
│  taskService.move() THEN githubService.syncState()      │
│  (one-way: routes → services, never service ↔ service   │
│   in both directions)                                   │
├─────────────────────────────────────────────────────────┤
│                   Service Layer                          │
│  TaskService  WikiService  ProjectService               │
│  ColumnService  SwimlaneService  AuthService            │
│  GitHubService ──depends on──▶ TaskService (webhooks)   │
├─────────────────────────────────────────────────────────┤
│                 Repository Layer                         │
│  TaskRepo  ProjectRepo  WikiRepo  ColumnRepo            │
│  SwimlaneRepo  ApiKeyRepo  WebhookEventRepo            │
├─────────────────────────────────────────────────────────┤
│               Infrastructure Layer                       │
│  Sqlite (bun:sqlite)   GitHubClient   Config (env)      │
└─────────────────────────────────────────────────────────┘
```

**The v1 cycle is gone:** `TaskService` has no GitHub dependency. `GitHubService → TaskService` is the only service-to-service edge, used by webhook handling. Lexa→GitHub sync is orchestrated by the route layer after a successful move.

## Infrastructure

```typescript
// The SQLite connection is created at boot from DATABASE_PATH and injected
// as a layer (server/db/database.ts). One connection, WAL mode, FK pragmas on.
export class Sqlite extends Context.Tag("Lexa/Sqlite")<Sqlite, Database>() {}
export const initSqlite = (dbPath: string) => Layer.succeed(Sqlite, new Database(dbPath));

// GitHub App credentials from env vars (LXK/GITHUB_* in .env / docker-compose)
export class GitHubConfig extends Context.Tag("GitHubConfig")<GitHubConfig, {
  readonly appId: string;
  readonly privateKey: string;      // PEM, for JWT signing
  readonly webhookSecret: string;   // for HMAC-SHA-256 verification
}>() {}

// GitHub API client. Installation tokens are cached ~50min (1h TTL minus
// margin) keyed by installation id — never minted per call. The cache lives
// in MODULE scope (outside the per-request Effect layer) — a per-request
// layer would mint a fresh token on every request.
export class GitHubClient extends Effect.Service<GitHubClient>()("GitHubClient", {
  effect: Effect.gen(function* () {
    const config = yield* GitHubConfig;
    // Hand-rolled fetch client + token cache initialized here
    return {
      createIssue: (repo: string, title: string, body: string) => ...,
      updateIssueState: (repo: string, issueNumber: number, state: "open" | "closed") => ...,
      getIssue: (repo: string, issueNumber: number) => ...,
      // HMAC-SHA-256 over the RAW request body, compared against the
      // X-Hub-Signature-256 header with constant-time comparison
      // (node:crypto createHmac — Bun runtime).
      // Runs BEFORE any JSON parsing. Failure → 401, no processing.
      verifyWebhookSignature: (rawBody: ArrayBuffer, signatureHeader: string) => ...,
    };
  }),
  dependencies: [/* ConfigLive */],
}) {}
```

## Repositories

Declared as `Effect.Service` (not bare `Context.Tag`), each with `dependencies: [SqliteLive]`-style wiring:

```typescript
export class TaskRepo extends Effect.Service<TaskRepo>()("TaskRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;
    return {
      create: (input: CreateTaskInput) => ...,
      findById: (id: string) => ...,                         // RowNotFound | DbError
      findByProject: (projectId: string, filters?: TaskFilters) => ...,
      // ATOMIC move: one conditional UPDATE (see SCHEMA.md SQL).
      // position is ALWAYS reassigned here — never kept from source column.
      // bypassWip: webhook-driven moves skip the count clause.
      move: (taskId: string, target: MoveTarget, opts?: { bypassWip?: boolean }) => ...,
      update: (id: string, input: UpdateTaskInput) => ...,   // sets updated_at
      delete: (id: string) => ...,
      findByGithubIssue: (githubIssueId: string) => ...,     // ≤1 row (UNIQUE)
      setGithubLink: (taskId: string, link: GithubLink) => ...,
      setGithubSyncedState: (taskId: string, state: "open" | "closed") => ...,
    };
  }),
}) {}

export class WebhookEventRepo extends Effect.Service<WebhookEventRepo>()("WebhookEventRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;
    return {
      isSeen: (deliveryId: string) => ...,                   // cheap pre-check
      // INSERT after successful processing (never before — a mid-processing
      // failure must leave the delivery unrecorded so GitHub's retry
      // reprocesses it; all handlers are idempotent).
      recordDelivery: (deliveryId: string) => ...,
      prune: (olderThanDays: number) => ...,                 // called by a boot/timer task
    };
  }),
}) {}

// ProjectRepo, WikiRepo (incl. content_text maintenance + FTS via triggers),
// ColumnRepo, SwimlaneRepo, ApiKeyRepo follow the same pattern.
// Repos surface: RowNotFound, DbError, ConstraintViolation (SQLITE_CONSTRAINT_*).
```

## Services

### TaskService — core logic, no GitHub dependency

```typescript
class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ id: string }> {}
class ColumnNotFound extends Data.TaggedError("ColumnNotFound")<{ id: string }> {}
class SwimlaneNotFound extends Data.TaggedError("SwimlaneNotFound")<{ id: string }> {}
class WipLimitExceeded extends Data.TaggedError("WipLimitExceeded")<{ column: string; limit: number }> {}
class RequiredFieldMissing extends Data.TaggedError("RequiredFieldMissing")<{ field: string; column: string }> {}
class NeighborNotInColumn extends Data.TaggedError("NeighborNotInColumn")<{ taskId: string }> {}

export class TaskService extends Effect.Service<TaskService>()("TaskService", {
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const projectRepo = yield* ProjectRepo;

    // --- pure helpers (v1's PolicyService, folded in) ---

    // TipTap emptiness: a doc with no text-bearing nodes is empty.
    // ('{}' default is truthy — v1's check never fired.)
    const isEmptyDoc = (json: string): boolean => { /* walk nodes, any text? */ };

    const validateRequiredFields = (task: Task, column: Column) =>
      Effect.gen(function* () {
        const required = JSON.parse(column.requiredFields) as string[];
        for (const field of required) {
          const empty =
            field === "description" ? isEmptyDoc(task.description)
            : field === "assignee"    ? !task.assignees || task.assignees.length === 0
            : !(task as any)[field];
          if (empty)
            return yield* new RequiredFieldMissing({ field, column: column.name });
        }
      });

    return {
      create: (input: CreateTaskInput) =>
        Effect.gen(function* () {
          const project = yield* projectRepo.findById(input.projectId);
          const column = yield* columnRepo.findById(input.columnId);
          if (column.projectId !== project.id)
            return yield* new ColumnNotFound({ id: input.columnId });
          // cross-project validation for swimlane too (v1 missed this)
          if (input.swimlaneId) {
            const lane = yield* swimlaneRepo.findById(input.swimlaneId);
            if (lane.projectId !== project.id)
              return yield* new SwimlaneNotFound({ id: input.swimlaneId });
          }
          // required_fields is enforced on ALL entry paths: create, move, update
          yield* validateRequiredFields({ description: '{}', ...input } as Task, column);

          // Key generation is DETERMINISTIC → on a position-UNIQUE violation the
          // retry must RE-READ the anchor (the concurrent winner's row is now
          // visible) before regenerating. Only the position conflict retries —
          // FK/NOT NULL violations surface as-is.
          const insert = Effect.gen(function* () {
            const last = yield* taskRepo.findLastInColumn(project.id, column.id);
            return yield* taskRepo.create({ ...input, position: generateKeyAfter(last?.position ?? null) });
          });
          return yield* insert.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => insert
            )
          );
        }),

      // Single atomic operation: column + swimlane + position in one call.
      // beforeTaskId/afterTaskId define the landing spot; position is
      // generated between them. No separate updateColumn/updatePosition —
      // v1's two-call split caused flicker and stale positions.
      move: (taskId: string, target: MoveTarget, opts?: { bypassGuards?: boolean }) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId);
          const column = yield* columnRepo.findById(target.columnId);
          if (column.projectId !== task.projectId)
            return yield* new ColumnNotFound({ id: target.columnId });
          if (target.swimlaneId) {
            const lane = yield* swimlaneRepo.findById(target.swimlaneId);
            if (lane.projectId !== task.projectId)
              return yield* new SwimlaneNotFound({ id: target.swimlaneId });
          }

          // No-op guard: same column AND no reposition request → early return.
          // Prevents echo-webhook no-ops from tripping WIP limits.
          if (task.columnId === target.columnId && !target.beforeTaskId && !target.afterTaskId)
            return task;

          if (!opts?.bypassGuards)
            yield* validateRequiredFields(task, column);

          // Position resolution — anchors are read INSIDE computePosition on
          // every attempt, so the retry below regenerates from fresh state:
          const computePosition = Effect.gen(function* () {
            if (target.beforeTaskId || target.afterTaskId) {
              const [before, after] = yield* Effect.all([
                target.beforeTaskId ? taskRepo.findById(target.beforeTaskId) : Effect.succeed(null),
                target.afterTaskId  ? taskRepo.findById(target.afterTaskId)  : Effect.succeed(null),
              ]);
              // neighbors must live in the TARGET column — stale client state
              // could otherwise interpolate keys from another column
              for (const n of [before, after])
                if (n && n.columnId !== target.columnId)
                  return yield* new NeighborNotInColumn({ taskId: n.id });
              return generateKeyBetween(before?.position ?? null, after?.position ?? null);
            }
            // no neighbors → default placement = append to end.
            // NEVER generateKeyBetween(null, null) here: it returns "a0", which
            // collides with the first task in any non-empty column — this path
            // is exactly what webhook moves and drop-on-empty-zone hit.
            const last = yield* taskRepo.findLastInColumn(task.projectId, target.columnId);
            return generateKeyAfter(last?.position ?? null);
          });

          const doMove = Effect.gen(function* () {
            const position = yield* computePosition;
            // WIP enforcement lives INSIDE the conditional UPDATE (atomic, with
            // a within-column-reorder short-circuit — see SCHEMA.md).
            // rowsChanged=0 here → WipLimitExceeded (task exists, guard failed).
            return yield* taskRepo.move(taskId, { ...target, position }, { bypassWip: opts?.bypassGuards });
          });

          return yield* doMove.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => doMove
            )
          );
        }),

      findByProject: (projectId: string, filters?: TaskFilters) => ...,
      getById: (id: string) => ...,
      update: (id: string, input: UpdateTaskInput) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id);
          const column = yield* columnRepo.findById(task.columnId);
          // a required field can't be cleared while the task sits in its guarded column
          yield* validateRequiredFields({ ...task, ...input }, column);
          return yield* taskRepo.update(id, input);
        }),

      // Webhook-only path: bypass-guard move + synced-state write as ONE
      // repo-level batch() — atomic (SCHEMA.md §No multi-statement ACID).
      // Phase 6 note: must NOT move archived tasks — add an archived-guard
      // (skip when task.archived_at IS NOT NULL) before moving.
      moveFromWebhook: (taskId: string, columnId: string, syncedState: "open" | "closed") => ...,

      delete: (id: string) => ...,

      // Archive/restore: idempotent soft-state flip on tasks.archived_at.
      // Archived tasks keep column/swimlane/position; board/WIP/count
      // queries exclude them unless includeArchived is set. No GitHub
      // interaction (routes orchestrate any sync, per the no-cycle rule).
      archive: (id: string) => ...,
      restore: (id: string) => ...,
    };
  }),
  dependencies: [/* TaskRepo, ColumnRepo, SwimlaneRepo, ProjectRepo */],
}) {}
```

### GitHubService — depends on TaskService (webhook direction only)

```typescript
export class GitHubService extends Effect.Service<GitHubService>()("GitHubService", {
  effect: Effect.gen(function* () {
    const client = yield* GitHubClient;
    const webhookEvents = yield* WebhookEventRepo;
    const taskRepo = yield* TaskRepo;
    const taskService = yield* TaskService;
    const columnRepo = yield* ColumnRepo;

    return {
      // ---- Lexa → GitHub (called by ROUTES after a successful move) ----
      // Pushes state, then records what we pushed so the resulting webhook
      // echo is recognized and skipped.
      syncStateFromLexa: (taskId: string, columnGithubState: "open" | "closed") =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId);
          if (!task.githubIssueId || !task.githubIssueNumber || !task.githubRepo) return;
          // repo comes from the TASK's stored "owner/name" (captured at link
          // time) — never parsed out of an html_url, never assumed to be
          // project.github_repo
          yield* client.updateIssueState(task.githubRepo, task.githubIssueNumber, columnGithubState);
          yield* taskRepo.setGithubSyncedState(taskId, columnGithubState);
        }),

      // ---- GitHub → Lexa (webhook processing) ----
      // Runs inside ctx.waitUntil — the route acks GitHub immediately (200)
      // to stay under GitHub's 10s timeout and avoid retry amplification.
      handleWebhook: (deliveryId: string, event: string, payload: any) =>
        Effect.gen(function* () {
          // 1. Cheap pre-check; the authoritative recordDelivery happens AFTER
          //    successful processing — a mid-processing failure must leave the
          //    delivery unrecorded so GitHub's retry reprocesses it. All
          //    handlers are idempotent (echo check, no-op guard, title
          //    overwrite), so duplicate processing is safe.
          if (yield* webhookEvents.isSeen(deliveryId)) return;

          // 2. Only state transitions and title edits are handled.
          //    (issues.labeled dropped — no label feature anymore.)
          if (event !== "issues.closed" && event !== "issues.reopened" && event !== "issues.edited")
            return;

          const task = yield* taskRepo.findByGithubIssue(payload.issue.node_id);
          if (!task) return;                                   // issue not linked to any task

          if (event === "issues.edited") {
            // Title sync is GitHub → Lexa only (documented asymmetry).
            yield* taskRepo.update(task.id, { title: payload.issue.title });
            return;
          }

          const incomingState = event === "issues.closed" ? "closed" : "open";

          // 3. ECHO SUPPRESSION: we already pushed this exact state → skip.
          if (task.githubSyncedState === incomingState) return;

          // 4. Column lookup by explicit mapping — never by name
          //    (renaming "Done" → "Shipped" can't break sync).
          const columns = yield* columnRepo.findByProject(task.projectId);
          const target = columns.find(c => c.githubState === incomingState);
          if (!target) return;                                 // no mapped column → no-op

          // 5. Webhook moves bypass WIP limits and required_fields
          //    (log-and-skip semantics: robots ≠ humans). Move + synced-state
          //    write execute as ONE SQLite transaction (batch helper) — atomic.
          yield* taskService.moveFromWebhook(task.id, target.id, incomingState);

          // 6. Record delivery only AFTER success (see step 1).
          yield* webhookEvents.recordDelivery(deliveryId);
        }),

      // One task ↔ one issue: guard against double-linking.
      createLinkedIssue: (taskId: string, repo: string) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId);
          if (task.githubIssueId)
            return yield* new GithubIssueAlreadyLinked({ taskId });
          const issue = yield* client.createIssue(repo, task.title, extractText(task.description));
          yield* taskRepo.setGithubLink(taskId, {
            issueId: issue.node_id,
            issueNumber: issue.number,
            repo,                       // stored "owner/name" — used by all future syncs
          });
        }),
    };
  }),
  dependencies: [/* GitHubClient, WebhookEventRepo, TaskRepo, TaskService, ColumnRepo */],
}) {}
```

### AuthService — Cloudflare Access + API keys

```typescript
export class AuthService extends Effect.Service<AuthService>()("AuthService", {
  effect: Effect.gen(function* () {
    const apiKeyRepo = yield* ApiKeyRepo;
    return {
      // HUMANS: deployment sits behind Cloudflare Access. Access enforces
      // the identity policy (email allowlist / GitHub org) BEFORE requests
      // reach the Worker. The Worker only reads the trusted header for
      // identity display. No OAuth code, no sessions, no CSRF surface.
      identityFromAccess: (headers: Headers) =>
        Effect.succeed(headers.get("Cf-Access-Authenticated-User-Email")),

      // MACHINES (MCP/Hermes): Authorization: Bearer lxk_<base62(32 bytes)>
      // Keys have full read/write — no scopes (single-agent trust model,
      // documented). SHA-256 lookup; last_used_at sampled (only when NULL
      // or older than 1h — avoids a write per MCP call).
      validateApiKey: (rawKey: string) =>
        Effect.gen(function* () {
          if (!rawKey.startsWith("lxk_")) return yield* new InvalidKey();
          const hash = hexSha256(rawKey);                    // Web Crypto
          const key = yield* apiKeyRepo.findByHash(hash).pipe(
            Effect.catchTag("RowNotFound", () => new InvalidKey()));
          yield* apiKeyRepo.touchIfStale(key.id, "1 hour");
          return key;
        }),
    };
  }),
  dependencies: [/* ApiKeyRepo */],
}) {}
```

## HTTP layer — @effect/platform HttpApi

Tagged errors map declaratively to statuses — no hand-rolled per-route mapping to drift from the catalog:

```typescript
const tasksApi = HttpApiGroup.make("tasks")
  .add(HttpApiEndpoint.post("move", "/projects/:slug/tasks/:id/move")
    .setPayload(MoveTaskPayload)      // { columnId, swimlaneId?, beforeTaskId?, afterTaskId? }
    .addSuccess(TaskSchema)
    .addError(TaskNotFound,        { status: 404 })
    .addError(ColumnNotFound,      { status: 404 })
    .addError(WipLimitExceeded,    { status: 409 })
    .addError(RequiredFieldMissing,{ status: 422 }))
  // ...other endpoints

// The move handler demonstrates the orchestration pattern that killed the cycle:
const moveHandler = (req) =>
  Effect.gen(function* () {
    const task = yield* TaskService.move(req.params.id, req.payload);
    const column = yield* ColumnService.getById(req.payload.columnId);
    if (column.githubState && task.githubIssueId) {
      // Best-effort, non-blocking: a GitHub failure never fails the move.
      yield* GitHubService.syncStateFromLexa(task.id, column.githubState).pipe(
        Effect.catchTag("GithubApiError", (e) => Effect.logWarning("sync failed", e)));
    }
    return task;
  });
```

The webhook route is exempt from API-key middleware and verifies `X-Hub-Signature-256` (HMAC-SHA-256, raw body, constant-time) before parsing; acks 200 immediately and processes via `ctx.waitUntil`.

## Pagination

All list endpoints and MCP `list_*`/`search_*` tools: `?limit` (default 50, max 200) + cursor (opaque: `"<columnId>:<position>:<taskId>"` for tasks). Unbounded lists would blow the MCP context window and Worker memory.

## TaggedErrors Catalog (v2)

| Error | HTTP | MCP code | Notes |
|-------|------|----------|-------|
| `TaskNotFound` | 404 | `TASK_NOT_FOUND` | |
| `ProjectNotFound` | 404 | `PROJECT_NOT_FOUND` | |
| `ColumnNotFound` | 404 | `COLUMN_NOT_FOUND` | |
| `SwimlaneNotFound` | 404 | `SWIMLANE_NOT_FOUND` | incl. cross-project refs |
| `WikiPageNotFound` | 404 | `PAGE_NOT_FOUND` | |
| `WipLimitExceeded` | 409 | `WIP_LIMIT` | atomic, from conditional UPDATE (not fired by within-column reorders) |
| `SlugTaken` | 409 | `SLUG_TAKEN` | SQLITE_CONSTRAINT on projects.slug or wiki_pages(project_id, slug) |
| `HasChildren` | 409 | `HAS_CHILDREN` | column delete with tasks; wiki-page delete with children |
| `NeighborNotInColumn` | 422 | `NEIGHBOR_NOT_IN_COLUMN` | beforeTaskId/afterTaskId not in target column |
| `GithubIssueAlreadyLinked` | 409 | `ALREADY_LINKED` | |
| `RequiredFieldMissing` | 422 | `REQUIRED_FIELD` | TipTap-aware emptiness; enforced on create/move/update |
| `OptionInUse` | 409 | `OPTION_IN_USE` | delete priority/type option still referenced by tasks |
| `InvalidOption` | 422 | `INVALID_OPTION` | unknown/foreign option id, duplicate label, or empty list |
| `SourceNotFound` | 404 | `SOURCE_NOT_FOUND` | delete a source that doesn't exist |
| `SourceFetchError` | 422 | `SOURCE_FETCH_ERROR` | bad URL / SSRF-guard block / unreadable page |
| `SourceUnreachable` | 422 | `SOURCE_UNREACHABLE` | fetch failed (timeout, DNS, network) |
| `ForgeTaskNotFound` | 404 | `FORGE_TASK_NOT_FOUND` | |
| `NoRuntimeOnline` | 409 | `NO_RUNTIME_ONLINE` | create Forge task with no daemon up |
| `TaskLinkNotFound` | 404 | `TASK_LINK_NOT_FOUND` | delete a link that doesn't exist |
| `TaskLinkCycle` | 409 | `TASK_LINK_CYCLE` | subtask_of would create a cycle |
| `InvalidTaskLink` | 422 | `INVALID_TASK_LINK` | self-link or cross-project link |
| `ConstraintViolation` | 500 | `CONSTRAINT` | internal; `isPositionConflict` variants are retried (create/move) before surfacing |
| `DbError` | 500 | `DATABASE_ERROR` | |
| `GithubApiError` | 502 | `GITHUB_API_ERROR` | never fails a user move |
| `GithubWebhookError` | 400 | `GITHUB_WEBHOOK_ERROR` | bad signature → 401 |
| `InvalidKey` / `MissingAuth` | 401 | `INVALID_API_KEY` / `MISSING_AUTH` | |

## Service Dependency Map (v2 — acyclic)

```
TaskService        → TaskRepo, ColumnRepo, SwimlaneRepo, ProjectRepo, FieldConfigRepo
FieldConfigService → FieldConfigRepo, ProjectRepo
ForgeService       → ForgeRepo, SourceRepo, SourceService, TaskRepo, WikiRepo, ProjectRepo
SourceService      → SourceRepo, ProjectRepo, WikiRepo
TaskLinkService    → TaskLinkRepo, TaskRepo, ProjectRepo
WikiService        → WikiRepo, ProjectRepo
ProjectService     → ProjectRepo, ColumnRepo, SwimlaneRepo, FieldConfigRepo
ColumnService      → ColumnRepo
SwimlaneService    → SwimlaneRepo
DashboardService   → TaskRepo, ColumnRepo, ProjectRepo, FieldConfigRepo
AuthService        → ApiKeyRepo
GitHubService      → GitHubClient, WebhookEventRepo, TaskRepo, TaskService, ColumnRepo, ProjectRepo
Routes/MCP         → all services (orchestration layer — the only place
                     TaskService and GitHubService meet)
```

## Cut from v1

- **PolicyService** — with only `required_fields` surviving, it collapsed into pure functions inside TaskService (`isEmptyDoc`, `validateRequiredFields`). One service and one repo query fewer on every move.
- **LabelService + LabelRepo** — feature cut (see SCHEMA.md).
