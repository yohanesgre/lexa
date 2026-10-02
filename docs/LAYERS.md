# Effect-TS Layer Architecture

## Layer Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│              API / Webhook Layer                           │
│  HttpApi routes (projects, columns, swimlanes, tasks,   │
│  wiki, settings)   GitHubWebhookRoute                   │
│                                                         │
│  Orchestration lives HERE: TasksRoute calls             │
│  taskService.move() THEN githubService.syncState()      │
│  (one-way: routes → services, never service ↔ service   │
│   in both directions)                                   │
├─────────────────────────────────────────────────────────┤
│                   Service Layer                          │
│  TaskService  WikiService  ProjectService               │
│  ColumnService  SwimlaneService  MilestoneService        │
│  WikiShareService  AttachmentService                     │
│  GitHubService ──depends on──▶ TaskService               │
│                        + ProjectService (webhooks)       │
├─────────────────────────────────────────────────────────┤
│                 Repository Layer                         │
│  TaskRepo  ProjectRepo  WikiRepo  ColumnRepo            │
│  SwimlaneRepo  MilestoneRepo  ApiKeyRepo  WebhookEventRepo │
│  WikiShareRepo  AttachmentRepo                           │
├─────────────────────────────────────────────────────────┤
│               Infrastructure Layer                       │
│  Sqlite (bun:sqlite)   GitHubClient   Config (env)      │
│  Storage (fs | Bun.S3Client)                             │
└─────────────────────────────────────────────────────────┘
```

**The v1 cycle is gone — no bidirectional service cycles:** `TaskService` never depends on `GitHubService`. The service-to-service edges that exist are all one-way: `GitHubService → TaskService` (+ `ProjectService`, used by webhook handling); `WorkspaceService → WorkspaceInvitesService, PasswordLinksService`; and `TaskService`, `TaskLinkService`, `SourceService` (+ `GitHubService`) → `ActivityService`. Lexa→GitHub sync is orchestrated by the route layer after a successful move. GitHubService also depends on `ProjectService` (workspace-repo validation, issue listing); content push is service-internal but stays GitHub-side — the route layer still owns move-time state sync. The removed runtime tier's `RuntimeMachineService → RuntimeEventService` / `RuntimeService → SourceService` edges are gone with their services.

## Infrastructure

```typescript
// The SQLite connection is created at boot from DATABASE_PATH and injected
// as a layer (server/db/database.ts). One connection, WAL mode, FK pragmas on.
export class Sqlite extends Context.Tag("Lexa/Sqlite")<Sqlite, Database>() {}
export const initSqlite = (dbPath: string) => Layer.succeed(Sqlite, new Database(dbPath));

// GitHub App credentials — the DB is the SINGLE source of truth at runtime.
// The non-secret identifiers are plaintext settings rows (github_app_id /
// github_app_slug); the PEM and webhook secret resolve ENCRYPTED-FIRST via
// resolveGithubAppSecrets — github_app_secrets (scope "github", AAD-bound to
// the row name) when written by the in-app manifest connect flow, with the
// legacy plaintext settings.github_private_key / github_webhook_secret rows
// as a fallback for existing installs. A manual PUT is the LAST EXPLICIT
// WRITE: it writes the plaintext settings row and deletes the matching
// encrypted row. Env (GITHUB_APP_ID / GITHUB_PRIVATE_KEY /
// GITHUB_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET) is a FIRST-BOOT BOOTSTRAP
// only: mirrorSettingsFromEnv copies it into the DB once at boot when keys
// are empty (GITHUB_PRIVATE_KEY inline wins over the file; the file is read
// at mirror time), and the runtime never reads env again.
// GitHubConfigLive serves a MUTABLE module-scope holder (never replaced):
// syncGitHubConfigFromDbAsync mutates it in place — applied at Bun boot via
// runGithubConfigBoot, at Workers boot, and after every PUT
// /api/settings/github — and is async because decrypting suspends. Every
// consumer, including the webhook verifier runtime, reads live values on each
// call. resetGithubCaches() drops cached installation ids/tokens after a save
// (a credential change must not keep signing with the previous app).
export class GitHubConfig extends Context.Tag("GitHubConfig")<GitHubConfig, {
  readonly appId: string;
  readonly privateKey: string;      // PEM, for JWT signing (PKCS#1 or PKCS#8 — normalized internally)
  readonly webhookSecret: string;   // for HMAC-SHA-256 verification
}>() {}

// GitHub API client. Installation tokens are cached ~50min (1h TTL minus
// margin) keyed by installation id — never minted per call. The cache lives
// in MODULE scope (outside the per-request Effect layer) — a per-request
// layer would mint a fresh token on every request. Per-repo installation
// resolution is cached the same way (Map<repo, installationId>).
// IMPORTANT: GitHub App keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto
// importKey("pkcs8") only accepts PKCS#8 — normalize via node:crypto
// createPrivateKey().export({type:"pkcs8",format:"der"}) before importKey.
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
      // (Web Crypto subtle.verify/importKey — pure, testable outside bun).
      // Runs BEFORE any JSON parsing. Failure → 401, no processing.
      verifyWebhookSignature: (rawBody: ArrayBuffer, signatureHeader: string) => ...,
    };
  }),
  dependencies: [/* ConfigLive */],
}) {}

// Blob storage (attachments + DB backups). Config is BOOT-TIME ENV like
// DATABASE_PATH — never the settings DB:
//   LXK_STORAGE_DRIVER=fs|s3          (default fs)
//   fs root = <dirname(DATABASE_PATH)>/blobs/
//   LXK_S3_ENDPOINT / LXK_S3_BUCKET / LXK_S3_ACCESS_KEY_ID /
//   LXK_S3_SECRET_ACCESS_KEY           (s3 driver; Bun.S3Client)
//   LXK_MAX_UPLOAD_MB                  (default 25 — upload cap, enforced at
//                                       route level AND as entry/middleware
//                                       body-cap raise for upload paths)
// The service is driver-agnostic: put/get/delete/stat/list over opaque keys
// ("blobs/<sha256>", "backups/<name>"). Drivers are plain factories
// (createFsDriver/createS3Driver) so backup.ts and tests can use them
// without an Effect runtime.
export class StorageConfig extends Context.Tag("Lexa/StorageConfig")<StorageConfig, StorageConfigShape>() {}
export class Storage extends Effect.Service<Storage>()("Lexa/Storage", {
  effect: Effect.gen(function* () {
    const cfg = yield* StorageConfig;
    const driver = cfg.driver === "s3" ? createS3Driver(cfg.s3) : createFsDriver(cfg.fsRoot);
    return {
      put: (key: string, data: Uint8Array) => ...,   // Effect<void, StorageError>
      get: (key: string) => ...,                     // Effect<Uint8Array, StorageError | KeyNotFound>
      delete: (key: string) => ...,                  // Effect<void, StorageError>
      stat: (key: string) => ...,                    // Effect<{ size } | null, StorageError>
      list: (prefix: string) => ...,                 // Effect<string[], StorageError>
    };
  }),
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

### Repo write contract (`void` writes)

- **`delete*` are idempotent** — 0 rows matched is not an error, they resolve
  `void`. Two exceptions fail `RowNotFound`:
  - Owner/pair-scoped deletes that must not leak existence: `ApiKeyRepo.deleteOwn`,
    `AssistantThreadRepo.resetThread`, `ProjectMemoryRepo.remove`.
  - `CommentRepo.softDelete` — a second delete of an already-deleted row matches
    0 rows and raises `RowNotFound` (`server/repos/comment.repo.ts:47-55`).
- **`update*`/`set*` fail `RowNotFound` when no row matched** — never a silent
  no-op. Repos get this either by re-reading the row through `queryFirst`
  after the UPDATE (which raises `RowNotFound`) or by checking
  `changes === 0` explicitly. `task.repo`'s link setters
  (`setGithubIssueTitle`/`setGithubSyncedState`/`setPushedContent`) check
  `changes === 0`; the two sync callers (`syncStateFromLexa`,
  `syncContentFromLexa`) map `RowNotFound` to `DbError` so no route status
  changes, while the webhook title-refresh callers
  (`handleWebhook` edit path on `setGithubIssueTitle`) log-and-continue.
  The one exception is `FieldConfigRepo.updateOption` — a plain void UPDATE on
  0 rows with no production caller (`server/repos/field-config.repo.ts:56-74`).
- **Audited exceptions** (keep `void`; caller must pre-check before
  strictifying):
  - `ApiKeyRepo.touchIfStale` — conditional stale-only touch; 0 rows is normal.
  - `AssistantPendingWritesRepo.markExecutionError` — best-effort flag; caller
    must pre-check.
  - `AssistantPendingWritesRepo.decide` / `expireIfDue` / `sweepExpired` —
    conditional transitions: the first two return the updated row or `null`
    when the guard fails, the third returns a count
    (`server/repos/assistant-pending-writes.repo.ts:56-83`); 0 rows is a
    normal guard, not an error.
  - `WebhookEventRepo.recordDelivery` (INSERT OR IGNORE) / `prune` — 0 rows is
    normal.

## Services

### TaskService — core logic, no GitHub dependency

```typescript
class TaskNotFound extends Data.TaggedError("TaskNotFound")<{ id: string }> {}
class ColumnNotFound extends Data.TaggedError("ColumnNotFound")<{ id: string }> {}
class SwimlaneNotFound extends Data.TaggedError("SwimlaneNotFound")<{ id: string }> {}
class WipLimitExceeded extends Data.TaggedError("WipLimitExceeded")<{ column: string; limit: number; current: number }> {}
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
      // Shipped (Phase 6): webhook moves skip archived tasks — archived-guard
      // on archived_at IS NOT NULL.
      moveFromWebhook: (taskId: string, columnId: string, syncedState: "open" | "closed") => ...,

      delete: (id: string) => ...,

      // Archive/restore: idempotent soft-state flip on tasks.archived_at.
      // Archived tasks keep column/swimlane/position; board/WIP/count
      // queries exclude them unless includeArchived is set. No GitHub
      // interaction (routes orchestrate any sync, per the no-cycle rule).
      archive: (id: string) => ...,
      restore: (id: string) => ...,

      // Bulk actions (POST /projects/:slug/tasks/bulk). Every id runs the
      // matching single-task method (move/update/archive/restore) inside ONE
      // withTx, so each task emits the SAME activity rows as the single-task
      // path (invariant #12 parity). Per-task DOMAIN rejections (not-found,
      // WIP_LIMIT, REQUIRED_FIELD, NEIGHBOR_NOT_IN_COLUMN, INVALID_OPTION,
      // DEADLINE_AFTER_LANE) are caught and COLLECTED in `failed` while the
      // permitted tasks still apply; DbError / ConstraintViolation are NOT
      // caught and abort the whole transaction — a request-level failure
      // changes NOTHING. A targetless move (no columnId and no swimlaneId)
      // fails with InvalidArgs before any write. Failure codes/messages come
      // from the error catalog via errorCodeMap/errorMessage, never
      // hand-rolled. ids are de-duped first-seen and capped at 100
      // (BULK_TASK_ID_CAP) BEFORE withTx. GitHub sync stays
      // route-orchestrated: after the transaction commits the ROUTE
      // best-effort syncs linked tasks (content push for update, state push
      // for a move to a github-mapped column) exactly as the single-task
      // handlers do — the service makes no GitHub calls (invariant #1).
      bulk: (projectId: string, input: BulkTaskInput) => ...,
    };
  }),
  dependencies: [/* TaskRepo, ColumnRepo, SwimlaneRepo, ProjectRepo */],
}) {}
```

### GitHubService — depends on TaskService + ProjectService (GitHub-side sync)

```typescript
export class GitHubService extends Effect.Service<GitHubService>()("Lexa/GitHubService", {
  dependencies: [GitHubClient.Default, WebhookEventRepo.Default, TaskRepo.Default, ProjectRepo.Default, ProjectReposRepo.Default, TaskService.Default, ProjectService.Default, ColumnRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const client = yield* GitHubClient;
    const webhookEvents = yield* WebhookEventRepo;
    const taskRepo = yield* TaskRepo;
    const taskService = yield* TaskService;
    const columnRepo = yield* ColumnRepo;
    const projectService = yield* ProjectService;

    return {
      // ---- Lexa → GitHub (called by ROUTES after a successful move) ----
      // Pushes state per linked issue, then records what we pushed so the
      // resulting webhook echo is recognized and skipped. Multi-issue:
      // Task.githubs is the junction table (task_github_issues), one link
      // per repo per task.
      syncStateFromLexa: (taskId: string, columnGithubState: "open" | "closed") =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId);
          for (const issue of task.githubs) {
            // repo comes from the STORED link ("owner/name" captured at link
            // time) — never parsed out of an html_url, never assumed to be
            // a project repo row
            yield* client.updateIssueState(issue.repo, issue.issueNumber, columnGithubState);
            yield* taskRepo.setGithubSyncedState(taskId, issue.issueId, columnGithubState);
          }
        }),

      // Lexa → GitHub content push (title + body, TipTap → Markdown). Runs
      // AFTER the mutation commits, best-effort, non-blocking — called from
      // REST updateTask when title/description changed.
      // Per link: skip when pushed_title/pushed_body already match
      // (normalizeMarkdownForEcho — trim + CRLF→LF); PATCH title+body; on
      // success write pushed_title/pushed_body/push_failed=false, on failure
      // push_failed=true (no retry queue — the next save retries naturally).
      // The push itself emits NO activity — the mutation's field_changed
      // rows stand.
      syncContentFromLexa: (taskId: string) => Effect.gen(function* () { /* ... */ }),

      // Workspace-repo validation for link/create/list paths.
      linkExistingIssue: (actor: Actor, taskId: string, repo: string, issueNumber: number) =>
        Effect.gen(function* () {
          // repo ∈ project workspace repos (else GithubApiError); already-linked
          // guard (issue → any task, or task → same repo); returns
          // { issueId, issueNumber, repo, activity } — link row + activity in
          // the same transaction; pushed_* seeded on first content push
        }),

      createTaskFromIssue: (actor: Actor, slug: string, repo: string, issueNumber: number) =>
        Effect.gen(function* () {
          // creates task in first/Backlog column from issue (Markdown → TipTap),
          // auto-links, respects required_fields like a normal create; returns
          // { taskId, activity }
        }),

      // Per-repo issue listing for the autocomplete; ~60s cache; exact
      // #number → direct issue GET fallback; already-linked excluded.
      listWorkspaceIssues: (slug: string, repo: string, query?: string) =>
        Effect.gen(function* () {
          // repo ∈ project workspace repos (else GithubApiError); returns
          // recent issues filtered by query (per_page=100, no search-API
          // dependency)
        }),

      // ---- GitHub → Lexa (webhook processing) ----
      // The route acks GitHub immediately (200) to stay under GitHub's 10s
      // timeout and avoid retry amplification. Bun has no waitUntil — the
      // handler acks first, then runs the Effect fire-and-forget on a shared
      // ManagedRuntime.
      handleWebhook: (deliveryId: string, event: string, payload: { action?: string; issue?: { node_id?: string; title?: string } }) =>
        Effect.gen(function* () {
          // 1. Cheap pre-check; the authoritative recordDelivery happens AFTER
          //    successful processing — a mid-processing failure must leave the
          //    delivery unrecorded so GitHub's retry reprocesses it. All
          //    handlers are idempotent (echo check, no-op guard, title
          //    overwrite), so duplicate processing is safe.
          if (yield* webhookEvents.isSeen(deliveryId)) return;

          // 2. GitHub sends X-GitHub-Event "issues" with the transition in
          //    payload.action (closed/reopened/edited) — compose the
          //    "issues.<action>" form. (issues.labeled dropped — no label
          //    feature anymore.)
          const action = payload.action ?? "";
          if (event !== "issues" || (action !== "closed" && action !== "reopened" && action !== "edited"))
            return;
          const nodeId = payload.issue?.node_id;
          if (!nodeId) return;

          const task = yield* taskRepo.findByGithubIssue(nodeId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          if (!task) return;                                   // issue not linked to any task

          if (action === "edited") {
            // CONTENT SYNC (GitHub → Lexa, echo-safe). The edited payload
            // carries the new title but NOT the body (only changes.body.from),
            // so every body sync needs an API fetch.
            // 1. Echo check: GET the issue; compare fetched title+body against
            //    pushed_title/pushed_body via normalizeMarkdownForEcho (trim +
            //    CRLF→LF at string edges). Both match → our own push → record
            //    delivery, skip. A title match alone is NOT proof of echo (we
            //    always push title+body together).
            // 2. GET failure fallback: compare payload title vs pushed_title —
            //    differ → apply title only (payload has it), skip body;
            //    match → skip entirely.
            // 3. Non-echo: taskService.update(actor { kind:'system', label:
            //    'github' }, task.id, { title, description: markdownToDoc(body) })
            //    — external edits win; the update emits field_changed rows in
            //    the SAME transaction (emission invariant).
            const link = task.githubs.find((g) => g.issueId === nodeId);
            const fetched = yield* client.getIssue(link.repo, link.issueNumber).pipe(
              Effect.catchAll(() => Effect.succeed(null)));
            if (fetched && !isEcho(link, fetched)) {
              yield* taskService.update({ kind: "system", label: "github", userId: null }, task.id, {
                title: fetched.title,
                description: markdownToDoc(fetched.body),
              }).pipe(Effect.catchAll((e) => Effect.logWarning("webhook edit apply failed", e)));
            } else if (!fetched && normalizeMarkdownForEcho(link.pushed_title) !== normalizeMarkdownForEcho(payload.issue?.title)) {
              yield* taskService.update({ kind: "system", label: "github", userId: null }, task.id, { title: payload.issue?.title });
            }
            yield* webhookEvents.recordDelivery(deliveryId);
            return;
          }

          const incomingState = action === "closed" ? "closed" : "open";

          // 3. ECHO SUPPRESSION (per link): we already pushed this exact
          //    state → skip.
          const link = task.githubs.find((g) => g.issueId === nodeId);
          if (link && link.syncedState === incomingState) return;

          // 4. Column lookup by explicit mapping — never by name
          //    (renaming "Done" → "Shipped" can't break sync).
          const columns = yield* columnRepo.findByProject(task.projectId);
          const target = columns.find(c => c.githubState === incomingState);
          if (!target) return;                                 // no mapped column → no-op

          // 5. Webhook moves bypass WIP limits and required_fields
          //    (log-and-skip semantics: robots ≠ humans). Move + synced-state
          //    write execute as ONE SQLite transaction (batch helper) —
          //    atomic. Archived tasks are never moved (archived-guard).
          yield* taskService.moveFromWebhook(nodeId, target.id, incomingState);

          // 6. Record delivery only AFTER success (see step 1).
          yield* webhookEvents.recordDelivery(deliveryId);
        }),

      // Create a GitHub issue from a task and link it. One task can hold
      // multiple issues but only one per repo — duplicate repo links are
      // rejected (ALREADY_LINKED). Repo must be a WORKSPACE repo of the
      // task's project (workspace validation, else GithubApiError → 502).
      createLinkedIssue: (actor: Actor, taskId: string, repo: string) =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId);
          if (task.githubs.some((g) => g.repo === repo))
            return yield* new GithubIssueAlreadyLinked({ taskId });
          const issue = yield* client.createIssue(repo, task.title, extractText(task.description));
          yield* taskRepo.setGithubLink(taskId, {
            issueId: issue.nodeId,
            issueNumber: issue.number,
            repo,                       // stored "owner/name" — used by all future syncs
          });
          return { issueId: issue.nodeId, issueNumber: issue.number, repo, activity: [] };
        }),
    };
  }),
}) {}
```

### API-key auth — plain functions, not an Effect service

There is no `AuthService` service. Auth is plain functions in
`server/api/auth-key.ts` + `server/api/middleware.ts` (no Effect layer, no
repos — raw SQL against the shared Sqlite connection). Better Auth 1.6.27
(pinned) runs in-process on the Bun server (`server/auth.ts` — credentials +
organization + `tanstackStartCookies` LAST, `baseURL` = `LXK_PUBLIC_URL`,
`useSecureCookies`, `trustedOrigins`), mounted at `/api/auth/*` BEFORE the
API-key middleware. No social providers, no SMTP — email/password only. Two
channels:

```typescript
// server/api/auth-key.ts:17 — resolveApiKeyIdentity(authHeader, headers, db, dbPath)
// MACHINES (CLI/webhooks): Authorization: Bearer lxk_<base62(43)>.
// Keys are USER-BOUND: user_id = owner; the key carries the owner's role
// (superadmin→admin, member→member) and userId, so per-project gates use the
// same AuthorizationService path as sessions. Member-bound keys are allowed
// (no middleware denial) — admin/superadmin gates still 403 them.
// user_id NULL = server key (legacy/dev rows only): role
// admin, attribution = key name. SHA-256 lookup; last_used_at sampled
// (only when NULL or older than 1h — avoids a write per API call).
export function resolveApiKeyIdentity(authHeader: string, headers: Headers, db: Database, dbPath: string): ApiKeyIdentity | null {
  // "lxk_" prefix + /^lxk_[0-9A-Za-z]{43}$/ shape check → sha256 →
  // api_keys.key_hash lookup; server keys (no user_id) resolve to role
  // 'admin'. Returns null on any failure → the middleware denies 401.
  // Keys bound to a deleted user resolve to null (row's user lookup 404s).
}
```

The dual-channel flow lives in `createApiMiddleware` (`server/api/middleware.ts`):
session cookie first (`auth.api.getSession` via the try/catch'd
`sessionIdentity`), Bearer key fallback (`resolveApiKeyIdentity`).

The API middleware accepts a session cookie OR a Bearer key on `/api/*`
(session tried first, key fallback). `x-lxk-user` is
removed — never sent by browsers, never read by the server. Browser
attribution = the session user; machine attribution = the key name
(`actorFromIdentity` adapts; see Attribution below).

**Superadmin is env-only:** `users.role` ∈ {superadmin, member} — set from
`LXK_ADMIN_EMAILS` at provisioning (setup wizard), never edited at runtime
(no role-editing endpoint; legacy `admin` →
`superadmin` in the migration; the `admin_emails` setting is deleted).
Team-admin authority comes from the org `member.role` (owner/admin) on the
team, never from `users.role`.

**Login rate limit (R17):** `/api/auth/*` failed logins are throttled by the
Better Auth rate-limit plugin (in-memory; ~5 attempts/60s per email, 15 min
lockout). The existing per-IP `/api/*` limiter is untouched.

### Device login (CLI pairing) — `DeviceLoginService`

Effect service (`server/services/device-login.service.ts` + thin
`server/repos/device-login.repo.ts`, SQL against the shared connection).
Pairs a terminal client with a user without a pre-shared credential —
capability-based, RFC-8628-flavored:

```
CLI ──POST /api/device-login/requests──► mint request
      ◄── { id, code, verifyUrl, expiresMs }   (token = 256-bit, hex)
browser ──GET <base>/device-login?token=…──► approve page (session required)
      ──POST .../requests/:id/approve { token }──► record approver (no mint)
CLI ──GET .../requests/:id (x-device-token)──► { status: approved, rawKey } ONCE
```

Rules:
- `token_hash` = hex(SHA-256(token)) — UNIQUE, backstop index; lookups by
  id; no plaintext secrets in the DB. The short `code` is display-only.
- Approve/deny require a **user-bound identity + token** (both) — the token
  is a 256-bit capability (from the verify URL), the identity may be a
  session cookie or a user-bound key. Bare server keys get 401/403.
- The minted key binds to the approver (`api_keys.user_id`), name =
  `client_name` (CLI sends `cli-<hostname>`), so it appears in the owner's
  Settings → Me → API keys.
- The key is minted on the CLI's first poll after approval: that poll
  atomically consumes the row (`DELETE … RETURNING`), then mints the
  user-bound key. Replay is impossible — a later poll is 404. No in-memory
  transit store: approve and poll may land on different isolates.
- Terminal states: denied (403 DEVICE_LOGIN_DENIED), expired (410 —
  `expires_at` = 10 min; expired rows purged at boot with the webhook prune).
- Middleware carve-out: create + poll are API-key exempt (the CLI has no
  credential yet) but stay rate-limited; approve/deny run through normal
  session auth — never exempt.

**Minting is only ever user-bound:** `ApiKeyService.createFor(userId, name)`
is the only mint path for UI/device keys; bare server keys cannot mint
(identity.userId null → 403 NO_USER_CONTEXT).

### SessionService — Better Auth session wrapper

Single owner of `auth.api.getSession`; the middleware and AuthService call
`userFrom` (never `auth.api.getSession` directly — the try/catch must live in
one place):

```typescript
export class SessionService extends Effect.Service<SessionService>()("Lexa/SessionService", {
  effect: Effect.gen(function* () {
    return {
      // try/catch is mandatory — an uncaught getSession throw crashes SSR.
      userFrom: (headers: Headers) =>
        Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
          Effect.map((s) => s?.user ?? null),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
    };
  }),
}) {}
```

### AuthorizationService — project access + team/settings gates

The project-access decision (order is binding — superadmin > grant > team >
deny) and the team/settings gates live in `server/services/authorization.service.ts`:

```typescript
// canAccessProject(userId, projectId):
//   1. user.role === 'superadmin'                                  → { access: 'admin' }
//   2. user_project_roles row for the project                      → { access: grant.role }
//   3. member row where organization_id = project.team_id
//        and user_id = user.id                                     → org role owner/admin ? 'admin' : 'member'
//   4. else                                                        → denied (404-style envelope)
// isTeamAdmin(userId, teamId): member.role ∈ {owner, admin} on that org, or superadmin
// isSuperadmin(userId): users.role === 'superadmin'
// Settings gate: superadmin only (R14) — API keys, rate limits, GitHub
// config, Assistant agents/skills, security are no longer 'admin'-gated;
// team admins get 403 on every server-settings route.
```

### ActivityService — timeline reads + appends

```typescript
export class ActivityService extends Effect.Service<ActivityService>()("Lexa/ActivityService", {
  dependencies: [ActivityRepo.Default, CommentRepo.Default],
  effect: Effect.gen(function* () {
    // append(taskId, actor, type, message) — single-statement insert (no
    // BEGIN), so it joins any outer withTx/batch transaction on the shared
    // connection. Callers invoke it INSIDE their mutation's transaction.
    // listMerged(taskId, cursor, limit) — keyset (created_at, rowid) per
    // table, in-memory merge of two bounded sets, slice to limit. Cursor
    // format "created_at|id|kind" (kind opaque — both tables are queried
    // with the same (created_at, id) keyset).
  }),
}) {}
```

### CommentService — comment lifecycle + authz

```typescript
class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}
class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {}
class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {}
class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}
// → 404 / 403 / 403 / 422 via server/api/errors.ts errorCodeMap + errorToStatus

export class CommentService extends Effect.Service<CommentService>()("Lexa/CommentService", {
  dependencies: [CommentRepo.Default, ActivityRepo.Default, TaskRepo.Default, UserProjectRoleRepo.Default],
  effect: Effect.gen(function* () {
    // create(taskId, actor, body: TipTapDoc) → { comment, activity }
    //   validateBody (TipTap doc + isEmptyDoc + ≤64KB) → CommentInvalid;
    //   existence pre-check → TaskNotFound (never a raw FK violation);
    //   comment insert + 'commented' activity in ONE withTx.
    // edit(commentId, identity, body) → author-only (authorKind 'user' AND
    //   authorId === identity.userId) else CommentEditForbidden. Sets
    //   edited_at; NO activity row (marker only).
    // remove(commentId, identity, projectId) → author OR project admin
    //   (identity.role === 'superadmin' OR user_project_roles.role === 'admin'
    //   OR team admin of the project's owning team — R14/Q13: superadmin all
    //   comments, team admin own team's projects); soft delete +
    //   'comment_deleted' activity in ONE withTx.
  }),
}) {}
```

**Emission invariant (the core rule):** every task mutation appends
`task_activity` row(s) in the SAME transaction as the mutation — one row per
meaningful change (updates may emit several `field_changed` rows);
position-only reorders emit nothing; webhook moves emit `github_synced` only
(actor system/'github', never `moved`); archived→archived no-ops emit
nothing. If the mutation rolls back, the activity rows roll back with it.
Messages are frozen at write time via the catalog
(`server/activity-messages.ts`) — never hand-rolled at call sites.

**Bulk parity:** `TaskService.bulk` runs each id through the matching
single-task method inside ONE transaction, so the emission rule above holds
per applied task; a per-task rejection collects into `failed` and writes
nothing for that id. That no-partial-write guarantee rests on error ordering:
every caught domain error is raised before the task's first write (all
validation runs ahead of the inner `withTx`; the WIP guard is a conditional
UPDATE that changes 0 rows when it rejects) — pinned by a regression test.
The route then best-effort syncs GitHub after the transaction commits, so a
bulk edit does not leave `pushed_*` stale and a bulk move still closes/opens
linked issues.

**Content-sync emission:** the Lexa→GitHub content push (`syncContentFromLexa`)
emits NOTHING — it runs after the mutation commits and the mutation's
`field_changed` rows stand alone. Webhook-applied edits (external GitHub
edits pulled in by the `edited` handler) DO emit `field_changed` rows (actor
system/'github') in the same transaction as the update — the invariant holds
in both directions.

### AttachmentService — uploads over content-addressed blobs

```typescript
class AttachmentNotFound extends Data.TaggedError("AttachmentNotFound")<{ id: string }> {}
class PayloadTooLarge extends Data.TaggedError("PayloadTooLarge")<{ size: number; maxBytes: number }> {}
class AttachmentDeleteForbidden extends Data.TaggedError("AttachmentDeleteForbidden")<{ id: string }> {}
// → 404 / 413 PAYLOAD_TOO_LARGE / 403 via server/api/errors.ts errorCodeMap + errorToStatus

export class AttachmentService extends Effect.Service<AttachmentService>()("Lexa/AttachmentService", {
  dependencies: [AttachmentRepo.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default,
                 UserProjectRoleRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    // upload({ projectId, taskId?, wikiPageId?, filename, bytes, declaredMime, actor })
    //   1. size cap → PayloadTooLarge (413) BEFORE any write.
    //   2. sha256 hex + magic-byte mime sniff (client mime NEVER stored).
    //   3. Dedupe lookup UNIQUE(project_id, sha256): hit → existing row
    //      UNCHANGED — no blob rewrite, no activity row.
    //   4. Miss → storage.put("blobs/<sha256>") OUTSIDE the tx, then ONE
    //      withTx: attachments INSERT + attachment_added activity row
    //      (task attachments only — wiki-page uploads emit nothing).
    //   5. filename sanitized (basename, control chars stripped, ≤255 chars).
    // remove(attachmentId, identity)
    //   Authority = uploader OR project admin (mirror CommentService.remove:
    //   superadmin / user_project_roles admin / team admin of owning org).
    //   ONE withTx: DELETE row + attachment_removed activity (task only);
    //   AFTER commit, refcount(storage_key) === 0 → storage.delete best-effort
    //   (failure logs a warn — orphan blobs are harmless by design).
    // serve(attachmentId) → { row, bytes } for GET routes; missing blob →
    //   AttachmentNotFound (+ warn log). Inline ONLY image/* + application/pdf;
    //   everything else Content-Disposition: attachment (nosniff is global).
    // resolveShare(token, attachmentId) → validates share link per request
    //   (missing == expired == revoked → ShareLinkNotFound), then requires
    //   attachment.wiki_page_id ∈ subtree(link.page_id) else AttachmentNotFound.
  }),
}) {}
```

**Actor resolution (attribution ≠ authorization):** browser users → the
Better Auth session user (`actorFromIdentity` maps it to kind 'user'); API
keys → kind 'agent' with the key's NAME as label and the key owner's
user id (unbound keys → NULL); webhook moves → kind 'system', label
'github'; Assistant terminal events → kind 'agent', label = resolved assistant
agent name (agent_id fallback). The legacy `x-lxk-user` header is gone — attribution
comes from the authenticated channel, never from a spoofable header; role
never comes from the browser either (authz stays server-side).

### MilestoneService — goal wrapper above sprints (cascade archive)

```typescript
class MilestoneNotFound extends Data.TaggedError("MilestoneNotFound")<{ id: string }> {}
class HasChildren extends Data.TaggedError("HasChildren")<{ count: number }> {}
// → 404 / 409 via server/api/errors.ts errorCodeMap + errorToStatus

export class MilestoneService extends Effect.Service<MilestoneService>()("Lexa/MilestoneService", {
  dependencies: [MilestoneRepo.Default, SwimlaneRepo.Default, TaskRepo.Default, ProjectRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    // create({ projectId, name, description?, dueAt? }) → Milestone
    //   (ProjectNotFound; position = max+1). getById / update →
    //   MilestoneNotFound (update also surfaces ConstraintViolation).
    // delete(id) → MilestoneNotFound | HasChildren — blocked while sprints
    //   reference the milestone (countSprints > 0); ON DELETE SET NULL on
    //   swimlanes.milestone_id is the safety net for direct DB writes only.
    // archive(actor, id) → { milestone, activity } — CASCADE in ONE withTx:
    //   milestone archivedAt + every sprint archived + each sprint's live
    //   tasks archived, one `archived` activity row per task + one per
    //   sprint + one per milestone (catalog msg.archived). Idempotent —
    //   an already-archived milestone returns unchanged, no rows.
    //   NO nested withTx (txDepth guard), NO service-to-service calls —
    //   deps are repos + ActivityService only (TaskService/SwimlaneService
    //   each wrap their own withTx; calling them here would nest).
    // restore(actor, id) → milestone only; its sprints stay archived
    //   (restore individually, mirroring lane-restore semantics).
    //   Idempotent.
  }),
}) {}
```

SwimlaneService (create/update) validates the sprint fields: `milestoneId` must
reference a milestone in the same project (`MilestoneNotFound` 404),
`startAt <= dueAt` (`InvalidArgs` 422), and the Backlog lane rejects
`dueAt` / `startAt` / `milestoneId` (`BacklogProtected` 409). Lanes are
created as kind `'sprint'`; the Backlog stays `'backlog'` (system-seeded,
one per project).

### MentionService — @-autocomplete search (read-only cross-repo lookup)

```typescript
export class MentionService extends Effect.Service<MentionService>()("Lexa/Mention", {
  dependencies: [TaskRepo.Default, WikiRepo.Default],
  effect: Effect.gen(function* () {
    // search(projectId, q) → { tasks: [{id, key, title}], wikiPages: [{id, slug, title}] }
    //   (DbError only). Case-insensitive substring on task key + title
    //   (archived excluded — task-link search precedent) and wiki title +
    //   slug. MENTION_RESULTS_CAP = 8: tasks first, wiki fills the
    //   remainder. Empty q → empty arrays (no unbounded listing).
  }),
}) {}
```

**Deliberately NOT folded into AssistantService:** this is a plain project-scoped
read with no provider/thread coupling; folding it in would give MentionService
transitive provider deps for zero benefit. Chat-side @-token resolution is
assistant-domain logic and lives in AssistantService's chat branch instead. The
service adds zero TaggedErrors — the only failure surface is `DbError`, and
access control happens at the route (`PROJECT_ACCESS_DENIED` 404), matching
every other project-scoped read.

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
    if (column.githubState && task.githubs.length > 0) {
      // Best-effort, non-blocking: a GitHub failure never fails the move.
      yield* GitHubService.syncStateFromLexa(task.id, column.githubState).pipe(
        Effect.catchTag("GithubApiError", (e) => Effect.logWarning("sync failed", e)));
    }
    return task;
  });
```

The webhook route is exempt from API-key middleware and verifies `X-Hub-Signature-256` (HMAC-SHA-256, raw body, constant-time) before parsing; acks 200 immediately and processes in the background (Bun has no `waitUntil` — the handler returns the ack, then runs the Effect fire-and-forget on a shared `ManagedRuntime`; `webhook_events` pruned at boot, >7 days).

### Assistant run — repoContent delivery

On an Assistant document run the stream handler assembles the per-run context: document title/context, resolved linked sources, memory hits, and — best-effort — the task's linked GitHub repo content (`repoContent: [{ owner, repo, path, content }]`, `[]` when none). The prompt points the agent at the content ("Linked GitHub repo content is in the repo-content/ directory…" concept, now assembled server-side into the prompt).

- **Sources:** the project's `project_repos` rows with `source_role = 1` → repo values ("owner/repo"), capped at the `assistant_repo_cap` setting (env bootstrap `LXK_ASSISTANT_REPO_CAP`, default 3), only when `documentType === "task"`. Task-linked issue repos no longer feed context.
- **Pipeline (per repo):** `GitHubClient.getDefaultBranch` → `getRepoFileTree(recursive=1)` → pure `selectRepoFiles` (`server/github/repo-content.ts`: skips node_modules/.git/dist/build/vendor/.next/coverage/target/.venv dirs, lockfiles, `*.min.js`/`*.min.css`/`*.map`, true binaries — svg stays; caps 50 files / 256 KB per file / 512 KB total, respecting tree sizes without fetching) → `getRepoFileContent` (per-segment URL-encoded path, base64 → UTF-8). Content truncated to 256 KB per file at assembly; total byte cap enforced across repos.
- **Never fails the run:** every failure (unconfigured app, missing repo, network, per-file) is caught per repo/file, logged `WARN`, and skipped — `repoContent` ends up `[]` and the run still proceeds. The prompt's repo-content line is added only when `repoContent` is non-empty.

### Lexa/Assistant Gateway — provider registry + cross-kind fallback

```typescript
export class AssistantGateway extends Effect.Service<AssistantGateway>()("Lexa/AssistantGateway", {
  dependencies: [AssistantProvidersRepo.Default, AssistantModelsRepo.Default,
                 AssistantCallLogsRepo.Default, AssistantModelPricesRepo.Default,
                 AssistantSettingsRepo.Default],
  effect: Effect.gen(function* () {
    // resolveFallback(projectId) → ProviderConfig[] (≤3, priority-ordered,
    // enabled models cross-kind, fresh adapter per attempt via buildAdapter).
    // streamChat(input) → AsyncIterable<StreamChunk>: iterates fallback configs,
    // fresh normalizeBaseUrl + buildAdapter per attempt, isRetriable = ProviderAuthFailed
    // | ProviderUnreachable | AssistantGenerationFailed, call_logs insert per attempt
    // (done/error/aborted/suspended), cost via assistant_model_prices (OpenRouter fetch).
    // No cycles: gateway depends on repos + Sqlite only — never on AssistantService.
  }),
}) {}
```

Thin gateway repos (Effect.Service, Sqlite only, no business logic):

```typescript
export class AssistantProvidersRepo extends Effect.Service<AssistantProvidersRepo>()("Lexa/AssistantProvidersRepo", {
  // assistant_providers(id,label,base_url,api_key,created_at,updated_at) — global, no project_id
  // thin: create/getById/list/maskedList/maskedView/update/delete; update sets updated_at = datetime('now')
}) {}
export class AssistantModelsRepo extends Effect.Service<AssistantModelsRepo>()("Lexa/AssistantModelsRepo", {
  // assistant_models(id,provider_id→assistant_providers ON DELETE CASCADE,model_id,kind CHECK openai_compatible|anthropic_compatible,priority,enabled)
  // thin: create/getById/listByProvider/listAll/update/delete
}) {}
export class AssistantCallLogsRepo extends Effect.Service<AssistantCallLogsRepo>()("Lexa/AssistantCallLogsRepo", {
  // assistant_call_logs(id,project_id→projects ON DELETE CASCADE,provider_id→assistant_providers ON DELETE SET NULL,model,kind,status CHECK done|error|suspended|aborted,error_code,usage_in/out,cached_in,latency_ms,cost_cents,estimated,created_at)
  // thin: insert/getById/listByProject/listByProvider/listByModel/listRecent
}) {}
export class AssistantModelPricesRepo extends Effect.Service<AssistantModelPricesRepo>()("Lexa/AssistantModelPricesRepo", {
  // assistant_model_prices(model PK,prompt_price,completion_price,cached_read_price,cached_write_price,updated_at) — OpenRouter cache, USD per 1M, price-sync upserts
  // thin: upsert/getByModel/list; upsert ON CONFLICT(model) DO UPDATE SET prompt_price,completion_price,cached_read_price,cached_write_price,updated_at=datetime('now')
}) {}
export class AssistantMcpRepo extends Effect.Service<AssistantMcpRepo>()("Lexa/AssistantMcpRepo", {
  // assistant_mcp_servers(id slug PK,label,transport_type CHECK http|sse|stdio,url,command,args JSON,secret_ref,enabled,created_at,updated_at)
  //   CHECK: (http|sse → url NOT NULL, command NULL) | (stdio → command NOT NULL, url NULL)
  // + assistant_mcp_project_servers(project_id→projects ON DELETE CASCADE,server_id→assistant_mcp_servers ON DELETE CASCADE,enabled,PK(project_id,server_id))
  // + assistant_mcp_secrets (0011) (server_id→assistant_mcp_servers ON DELETE CASCADE,ciphertext,iv,key_id,created_at,updated_at) — one row
  //   per client; ciphertext only, never on a registry row. Thin upsert putSecret / deleteSecret (both crypto-free —
  //   the service encrypts, this layer only stores); remove deletes the secret row explicitly because the Bun runner
  //   has foreign keys OFF and the cascade would not fire. Every read goes through one LEFT JOIN projection
  //   (SELECT_WITH_SECRET), so the blob never lands in a bare SELECT * of the registry.
  // thin: list/getById/create/update/remove/listForProject/setProjectServers (withTx replace-set); update sets updated_at = datetime('now')
  // toPublic/projectToPublic ignore secret_ref AND drop the ciphertext columns → hasSecret + secretSource
  //   ("managed"|"none") — legacy `secret_ref` is never a credential; hasSecret is true exactly when a managed
  //   ciphertext row exists (managed-only since 2026-09-28; migration 0012 cleared every stored ref)
  // the stored column domain still names 'stdio' (D1 cannot drop a column or rewrite the CHECK) and
  // migration 0010 deletes every such row; read types keep McpTransportType, while create/update
  // inputs take McpClientTransportType ("http" | "sse") so a caller cannot persist stdio.
}) {}
// AssistantSettingsRepo after the squashed baseline + 0008: assistant_settings dropped kind/base_url/api_key/model/vision_model
// (baseline) and engine/engine_switcher_enabled (0008) — now only
// search_provider, search_api_key, url_allowlist,
// primary_supports_images, reasoning_effort, write_tools + project_id PK. Thin upsert/maskedView.
// price-sync: server/assistant/price-sync.ts fetch OpenRouter → assistant_model_prices upserts, per-token strings ×1e6 to USD per 1M (superadmin POST /admin/assistant/prices/sync).
```

### Lexa/AssistantMcpService — remote MCP client registry

```typescript
export class AssistantMcpService extends Effect.Service<AssistantMcpService>()("Lexa/AssistantMcpService", {
  dependencies: [AssistantMcpRepo.Default],
  effect: Effect.gen(function* () {
    // Also requires McpConnector (injectable seam @Context.Tag). The live connector
    // (HTTP+SSE JSON-RPC tools/list) is server/assistant/mcp.ts
    // `LiveMcpConnector`, wired as the default in the API layer; tests inject a fake.
    return {
      // list/create/update/remove — id is slugified from the label (no reserved id);
      // listForProject/setProjectServers — replace-set availability (validates ids);
      // testConnection — always resolves: a failed connect folds into
      //   { ok:false, error:{code,message} }, never a thrown error.
      // Validation (pure validateTransportConfig): REMOTE http/sse only. `stdio` →
      //   MCP_INVALID_TRANSPORT_CONFIG on every runtime — no process is ever spawned;
      //   http/https url with no userinfo; `command`/non-empty `args` rejected (never
      //   dropped). The accepted branch returns the narrowed McpClientTransportType, so
      //   the repo write is remote-only by construction. (The env:/file: reference
      //   validation block was removed with reference mode, 2026-09-28.)
      // Secret intent: managed-only, resolved BEFORE any write (normalizeSecretIntent
      //   reads the REQUEST only — a stored value is never an input, so an unrelated
      //   patch can never clear a credential):
      //     managed   — `secret` encrypted into assistant_mcp_secrets
      //     clear     — `clearSecret: true`; deletes the blob row
      //     none      — a legal, deliberately secret-less client (clear + a value is
      //                 refused; a save carrying `secret` needs a master key)
      //   An empty/blank `secret` is ABSENT, not a value: "empty means keep" is why
      //   removal needs the explicit clearSecret flag. A `secretRef` in the request is
      //   accepted-and-ignored at the HTTP layer, never mapped here.
      // SSRF: validateUrl at save time; the connector revalidates at connect time.
      // No cycles: repo + connector only — never GitHubService or chat services.
    };
  }),
}) {}
```

### Assistant MCP tool bridge — `server/assistant/mcp.ts`

Read-only MCP tools reach the model through the same `tools` array as the
in-repo registry; there is no second execution path.

```typescript
// server/assistant/mcp.ts — plain module in the assistant tier (no service cycle).
export async function buildMcpTools(opts: {
  servers: McpServerRowWithSecret[]; projectId: string; env: RuntimeEnv; allowlist: string | null;
  connector?: McpClientFactory;   // injectable fake for tests; default = live
  onToolCall?: McpToolCallSink; discoveryTimeoutMs?: number; toolCallTimeoutMs?: number;
}): Promise<{ tools: unknown[]; close: () => Promise<void> }>

// ENABLED_MCP_SERVERS_SQL: global `enabled = 1` AND project row `enabled = 1`.
// LiveMcpConnector: Layer for the McpConnector tag (registry test endpoint).
```

- **Names:** `mcp__<serverId>__<tool>`; the id is sanitized to `[a-z0-9_]`
  (segment capped 24) and the tool segment truncated so the joined name never
  exceeds the provider limit (`MCP_TOOL_NAME_MAX = 64`). Collisions across
  servers are skipped (logged), never fused.
- **Filtering is manual and default-deny:** `isReadOnlyMcpTool` reads
  `tool.metadata.mcp.annotations.readOnlyHint === true` (ai-mcp 0.4.6 has no
  `toolFilter`). Tools without the annotation are listed nowhere and never
  handed to the model — v1 exposes only provably read-only tools.
- **Lifecycle:** one `createMCPClient` per server, discovery under
  `Promise.allSettled` with a 5s per-server timeout; a failed/timed-out server
  is skipped (fail-open, logged). `close()` is idempotent (double-close guarded)
  and is passed to `buildStream` as `onDispose`.
- **Dispose:** `StreamRunContext.onDispose` runs in `buildStream`'s existing
  `finally`, so the done / fail / cancel paths each close the MCP clients
  exactly once (tests cover all three).
- **Caps:** 30s per tool call (`MCP_TOOL_CALL_TIMEOUT_MS`, abort + race) and
  100 000 chars per result (`MCP_TOOL_RESULT_CAP`).
- **SSRF:** http/sse URLs re-run `validateUrl(url, allowlist)` at connect time
  (`validateMcpTransportUrl`) — the save-time pass is fast feedback only.
- **Remote auth:** the transport builder sends exactly one header —
  `Authorization: Bearer <managed token>` — and no header at all for a
  genuinely secret-less client. Managed-only (2026-09-28): a stored
  `assistant_mcp_secrets` row is decrypted here and is the **only** credential
  source; a legacy stored `secret_ref` with no blob **hard-fails**
  `McpConnectFailed` (never an anonymous connect, which would be
  indistinguishable from a working client). The secret row is opened only here,
  at connect — never in the repo, the service, or a public shape; see "Managed
  MCP client secrets" below for the failure split. (The `resolveSecretRef`
  env/file path and its save-time allowlist/denylist validation were deleted
  with reference mode.)
  - A decrypted token with CR/LF/NUL is refused with a fixed `McpConnectFailed`
    message before the factory/SDK is called; otherwise fetch throws a
    `TypeError` that quotes the value. Both sinks then redact: `toConnectError`
    (test-report body) and `logMcpSkip` (stderr) replace **all** third-party
    connect text — SDK, fetch, remote JSON-RPC — with one fixed generic message,
    and only a `McpConnectFailed` Lexa constructed itself keeps its own text.
- **stdio:** removed. `AssistantMcpService` accepts http/sse only and returns
  `McpInvalidTransportConfig` for a `stdio` payload on every runtime, so no code
  path spawns a child process; migration 0010 deletes every stored stdio
  registration and its project bindings. `server/assistant/mcp-stdio.ts` and its
  lazy `@tanstack/ai-mcp/stdio` import are deleted, the bridge filters rows
  through `isRemoteMcpTransport` before any factory call, and the
  `McpStdioUnavailable` catalog entry is reserved but never constructed or
  emitted (kept only so a client decoding the code still parses the wire).
- **Workers output-schema validation:** the SDK's AJV validator compiles with
  `new Function`, forbidden on workerd; on Workers a permissive
  `jsonSchemaValidator` is supplied and wrapped tools drop `outputSchema`.
- **Audit (deviation):** each call logs a structured call-log line
  (`service: "assistant-mcp"`: serverId, toolName, ok/error, durationMs;
  injectable `onToolCall`). `assistant_call_logs.kind` is CHECK-pinned to
  provider kinds, so a real DB row needs a rebuild migration — deferred, not
  smuggled into this change. No `task_activity` rows (MCP calls are not task
  mutations).
- **No cycle:** `mcp.ts` imports the repo type, env, errors, ssrf, the
  `McpConnector` tag, and `@tanstack/ai-mcp` — never a chat/task service.

Wiring: `AssistantChatService` (stream + resume) and `AssistantTaskService`
(stream + resume) load `ENABLED_MCP_SERVERS_SQL` for the project, call
`buildMcpTools`, append `.tools` after the registry/write tools (and the vision
tool), and pass `onDispose: toolset.close`. The live connector is the API-layer
default (`createApiHandler(..., { mcpConnector })` still overrides for tests).

### Managed secrets module — `server/assistant/secrets.ts`

One plain assistant-tier module envelope-encrypts every credential the webapp
manages — MCP client tokens (`mcp`), LLM provider API keys (`provider`), and the
Jev API key (`jev`). A credential is **entered** in the webapp and stored
AES-256-GCM encrypted in the scope's table
(`assistant_mcp_secrets` / `assistant_provider_secrets` / `assistant_jev_secrets`);
the master key lives only in the environment. Prose-only (no invariant
registration), consistent with the other MCP rules above.

```typescript
// server/assistant/secrets.ts — PLAIN module, not an Effect.Service, no DB, no
// Node builtins (Web Crypto + atob/btoa only), so it runs on Bun and workerd.
export const SECRET_AAD_PREFIXES: Record<SecretScope, string>
//   mcp: "lexa-mcp-v1" (FROZEN — stored MCP blobs authenticate against it)
//   provider: "lexa-provider-v1" | jev: "lexa-jev-v1"
export async function secretsKeyringFromEnv(env): Promise<SecretKeyring | null>  // null = no active key
export async function secretsManagedEnabled(env): Promise<boolean>
export async function parseMasterKey(raw: string | null | undefined): Promise<CryptoKey>
export async function encryptSecret(plaintext, scope, ownerId, key, keyring?): Promise<EncryptedSecret>
export async function decryptSecret(row: SecretRow, keyring: SecretKeyring): Promise<string>
export function keyIdFor(key): SecretKeyId | null
export function keyringFromKeys(active, prev?): SecretKeyring
```
- **Key handling.** `parseMasterKey` imports as **non-extractable**
  (`extractable: false`), so the raw bytes cannot be read back out of the
  runtime. AES-256-GCM is the only AEAD both Bun and workerd expose through
  `crypto.subtle` (XChaCha20/ChaCha20 are unavailable on workerd, and no new
  WASM dependency is wanted). The keyring tracks slot membership in a
  `WeakMap` keyed by the `CryptoKey` object, so a key imported twice re-registers
  under the same slot rather than colliding, and an unregistered key is refused
  rather than mislabelled.
- **Scope + owner are authenticated, not just stored.** The AAD is
  `<prefix>:<ownerId>` with a frozen prefix per scope, so a blob copied onto
  another row or another scope fails to decrypt. Scope names and prefixes are a
  closed vocabulary (`mcp` / `provider` / `jev`); `lexa-mcp-v1` must never
  change.
- **`key_id` is the keyring slot** (`active` / `prev`), never a fingerprint,
  counter, or date. `decryptSecret` tries the active key first and falls back to
  `prev`, so a rotation demotes the active key without a rewrap; an unknown slot
  is refused before any key is tried. Every failure class (wrong key, tampered
  blob, foreign owner/scope, unknown slot) is one fixed message —
  `SECRET_DECRYPT_FAILED` — so nothing about the row leaks.
- **Unset vs malformed.** `secretsKeyringFromEnv` returns `null` for an unset
  key (the documented disable switch: a managed save is refused and secret-less
  use keeps working); a configured-but-malformed key is an error, never a silent
  disable. `secretsManagedEnabled` reads the same env snapshot the save path
  reads (unset → `false`, malformed → `true`) so the rendered capability and the
  enforced one cannot drift, and it never throws.

### Provider secrets — `AssistantProvidersService`

Provider API keys use the shared envelope module scoped `provider`, AAD-bound to
the provider id. `AssistantProvidersRepo` keeps the blob out of the registry
(LEFT-JOIN aliases `secret_ciphertext` / `secret_iv` / `secret_key_id`);
`AssistantProvidersService` seals on create/update (`clearKey: true` is the only
removal route and is crypto-free), and `resolveApiKey` / `resolveApiKeyForRow`
open a stored key for the test/probe endpoints and the gateway. A stored but
unopenable key is a hard `ProviderAuthFailed` with the fixed
`PROVIDER_KEY_UNDECRYPTABLE` message — never a silent empty header.

- **Boot backfill (`server/db/provider-secrets-backfill.ts`).** One-way and
  idempotent: every non-empty `assistant_providers.api_key` is encrypted into
  `assistant_provider_secrets` (scope `provider`) and the legacy column is then
  written `''`. No keyring → nothing is written and the blocked count is logged;
  a credential is never cleared before a usable replacement is stored. It runs
  after the env mirror at Bun boot (`server/entry.ts`) and, on Workers, on the
  per-isolate first request inside `ensureBoot` (`server/workers-entry.ts`) —
  concurrent cold starts share one boot promise, and re-running is a no-op. The
  legacy column is dead in Release N and dropped in Release N+1.

### Jev advisory boundary — `server/assistant/jev.ts` + `AssistantJevService` + `jev_assess`

Typesafe Jev is a **typed System 1 judgment REST API**, not a chat-completion
provider, a text-generation model, or an MCP endpoint. `server/assistant/jev.ts`
stays a **plain assistant-tier module** — no `Effect.Service`, no DB, no service
edge — and the chat/task services *call* it; nothing calls *it*. Configuration is
no longer env: it lives in the DB registry (`assistant_jev_config` /
`assistant_jev_secrets` / `assistant_jev_projects`, migration 0013) and is
resolved per request by `AssistantJevService` over `AssistantJevRepo`.

```typescript
// server/services/assistant-jev.service.ts — Effect.Service over AssistantJevRepo.
resolveForProject(projectId): Effect<JevRuntimeConfig | null>
//   global enabled=1 AND the project row enabled=1 AND a stored, openable key.
projectAvailable(): Effect<boolean>
//   global enabled=1 AND a stored, openable key — this project's row is ignored,
//   so a member can render the disabled toggle without superadmin read access.
readConfig(): Effect<{ config, secretsEnabled }>   // masked: hasKey/keyMask only
updateConfig(input): Effect<...>                   // baseUrl/model/enabled/secret/clearSecret
probe(): Effect<{ ok, latencyMs, models }>         // backing POST /assistant/jev/test

// server/assistant/jev.ts — plain module, no Effect, no tags, no deps, no DB.
export interface JevRuntimeConfig { apiKey: string; baseUrl: string; model: string }
export async function systemOne(params: SystemOneParams): Promise<JevResult>
export async function listJevModels(params): Promise<JevModelsResult>
export function buildPreflightState(input: PreflightStateInput): string
export const PREFLIGHT_QUESTIONS: JevQuestions
export function buildAdvisorySegment(answers: Record<string, JevAnswer> | null | undefined): string
export async function runJevPreflight(params: JevPreflightParams): Promise<JevPreflightResult>
export function jevLog(mode: "preflight" | "assess", result: JevLogMeta): void
```

- **The registry is the disable switch; the env keys are gone.** The historical
  Jev env-only variables no longer exist. Jev runs only when the singleton config
  row is `enabled = 1`, the project has an enabled `assistant_jev_projects` row,
  and a key is stored and openable under the shared master key
  (`LXK_SECRETS_MASTER_KEY`, scope `jev`, AAD-bound to `config_id`).
  `resolveForProject` is total — any failure (row missing, flags off, key absent,
  keyring unset, blob undecryptable) yields `null`, and every caller fails open.
  The project read's additive `available` is that same resolution minus the
  project row, so a non-superadmin can render the disabled toggle + configure
  notice without ever touching key material.
- **Transport is the official SDK under our cap.** `jev.ts` uses
  `@typesafe-ai/sdk` (`TypeSafeClient`, pinned `0.6.0`) with `cappingFetch` as
  its `fetch`. `cappingFetch` owns the 64 KB cap on **both** ok and non-ok
  bodies: a declared `content-length` short-circuits the read, otherwise a
  streaming byte counter cancels the reader at the cap. On a 2xx an over-cap body
  throws before the SDK can materialize it; on a non-ok response the body is
  capped and returned (the SDK reads it to build its error) **without** throwing —
  an oversized error body is not a failure of its own, the recorded status is.
  Client options are `retry: { maxRetries: 0 }`, a per-attempt `timeout`, and
  `logLevel: "off"`; the client is rebuilt per call because base URL / model /
  key are request-time DB values, never process constants.
- **Failure is a closed, typed vocabulary that never quotes upstream.** Every
  thrown SDK/transport error reduces to `MISSING_KEY | TIMEOUT | NETWORK | AUTH |
  RATE_LIMITED | INVALID_RESPONSE | HTTP_<status>`: a capping breach →
  `INVALID_RESPONSE`, an abort/timeout error name → `TIMEOUT`, 401/403 → `AUTH`,
  429/529 → `RATE_LIMITED` (529 is Typesafe's overload signal), any other status
  the transport saw → `HTTP_<status>`, no status → `NETWORK`. No branch reads the
  error's own message — it can quote the key or the response body; failures are
  reported as a fixed catalog string. A missing/blank key returns `MISSING_KEY`
  before any request, so Jev never sends an anonymous `Bearer " "`. Every answer
  is re-validated (`noul`/`choice`/`score` shapes, `noul ∈ [0,1]`) and **every
  question asked must come back answered**, or the whole call is
  `INVALID_RESPONSE`.
- **No retry, fail-open.** A retry cannot fit the 3s preflight budget, and both
  paths fail open on one attempt: the preflight yields no block and no throw, the
  tool returns a typed failure the model can read and route around.
- **Preflight flow (once per NEW run).** `AssistantChatService.runChatStream`
  and `AssistantTaskService.runStream` resolve the config once per run through
  `AssistantJevService` (the service already encodes global-enabled + project
  opt-in + a usable key), then build the state from inputs the run has
  *already loaded* — run kind, project/thread ids + labels, the latest user
  message, the task/wiki context, project-memory hits — and await the verdict
  **before** `buildStream` (so the advisory is in the prompt the model gets).
  `buildPreflightState` is a whitelist type with a fixed key order: there is no
  index signature and no spread, so an extra key on a caller's object cannot
  reach the wire. No history, no attachments, no credentials. Caps
  (`JEV_PREFLIGHT_*`): ids 128 chars, labels 200, each memory item 400, message
  2 000, task/wiki context 4 000, serialized state 8 000 — the total closed by a
  deterministic squeeze (context first, then message, then the memory tail).
  `clip()` marks a shortened field with `…`; see **lossy paths** below for what
  the squeeze drops without a marker. A `null` config is the documented disable
  switch: `runJevPreflight` returns `skipped` without attempting a request.
- **Fixed questions** (`PREFLIGHT_QUESTIONS`, stable ids — changing one is a
  behavior change): `write_intent` (choice `none|read|write`), `ambiguity`
  (noul), `memory_conflict` (noul). The advisory segment
  (`buildAdvisorySegment`) is a labeled `Jev advisory (non-authoritative)`
  block — one `- ` line per answer, plus a fixed footer that write tools remain
  approval-gated and live project data remains authoritative. A mistyped or
  unrecognized answer drops its line instead of throwing, and the write-intent
  choice is filtered against the closed option set so upstream text can never
  reach the prompt verbatim.
- **`jev_assess` tool** (`server/assistant/tools.ts`, `buildJevAssessTool`) is
  added to the toolset **only when the run resolved a config** (`jevConfig`
  absent/null omits it entirely) — the same gate shape as `web_search`'s Exa key,
  so a disabled Jev leaves the toolset byte-identical. Input is a bounded `state`
  plus a `z.discriminatedUnion` mirror of the `noul`/`choice`/`score` contract (a
  malformed question never reaches the wire). Result is typed: `{ ok:true,
  answers, usage }` or `{ ok:false, code, message }` — a failure never throws
  into the stream, so the model can read it and continue.
- **Budgets.** Preflight: 3s (`JEV_PREFLIGHT_TIMEOUT_MS`) and 8 000 state
  chars, once per new run. Tool: 10s per request
  (`JEV_TOOL_TIMEOUT_MS`), ≤4 000 state chars (`JEV_ASSESS_MAX_STATE_CHARS`),
  ≤8 questions (`JEV_ASSESS_MAX_QUESTIONS`), ≤3 calls per stream invocation
  (`JEV_ASSESS_MAX_CALLS`, over-budget → typed `BUDGET_EXCEEDED`). The call
  counter lives in the `buildAssistantTools` closure, so a resume gets a fresh
  budget and the counter cannot outlive the run that created it. Oversize tool
  input is **refused, not truncated** (`STATE_TOO_LARGE`): a judgment silently
  computed over a clipped state is a judgment over something the model never
  sent.
- **Lossy paths (preflight only).** The tool is never lossy — oversize input is
  refused. The preflight state builder is, on three levels: every field is
  clipped at its own cap and the clip is marked with `…` (ids 128, labels 200,
  memory items 400, message 2 000, context 4 000); the 8 000-char squeeze clips
  the context and then the message, also marked — but **deletes** either field
  outright when no room is left for it; and the memory **tail is dropped
  unmarked**, one item at a time, until the list is empty and the `memory` key
  disappears. A clipped field is visibly clipped; a dropped field or a dropped
  memory item is not, so a verdict may be missing context the run had.
- **Resume.** `resumeChatStream` / `resumeThreadStream` build no preflight
  state and make no Jev call — the judgment was made against the original
  request — but the `jev_assess` tool **is** still offered, because its budget
  is per stream invocation. The tools are therefore assembled on both paths;
  only the preflight is new-run-only.
- **Env and DB are read at call time.** `currentEnv` (`server/runtime-env.ts`)
  is resolved when a service *method* runs, not when its layer is built, so the
  `RuntimeEnv` snapshot must be provided to the effect (the same place
  `server/api/http.ts` provides it per request) and not only to the built
  layer — this is what lets the master key be read per save/resolve. The Jev
  config row is likewise read per request, never cached at layer build. Missing
  the env is a `Service not found` defect at run time, not a typed error.
- **Logging is bounded by type.** `jevLog` takes `(mode, result)` and the meta is
  declared field by field, so a rendered advisory segment cannot ride along in a
  log line. One stderr line: `mode`, `outcome`, `code?`, `latencyMs?`,
  `usage?`, timestamp. No state, no key, no upstream body. `code` is the
  caller's own typed code (`JevFailureCode` for the preflight,
  `JevAssessFailureCode` for the tool); `latencyMs` is omitted when the call
  never reached the network (e.g. the per-stream budget refusal) rather than
  logged as a fabricated 0. A `MISSING_KEY` preflight — Jev disabled or
  unconfigured, a deployment state rather than a run event — logs no line at all,
  so the `skipped` outcome is returned but not written once per run.
- **No cycle (invariant #1), no write (invariant #12).** `jev.ts` imports nothing
  from a repo or service — only the SDK and its own types; the assistant services
  depend on it, never the reverse. `AssistantJevService` sits beside the chat/task
  services and imports the repo, the secrets module, and the error catalog, never
  a chat/task service. Jev is advisory text: it cannot queue a write, apply a
  pending row, or emit `task_activity`. Writes still go through the existing
  approval protocol, and the advisory footer says so to the model in-band.

Tests: `server/assistant/jev.test.ts` (SDK fake-fetch transport, status mapping,
caps, no-retry, invalid answers, preflight fail-open/disable, log shape),
`server/services/assistant-jev.service.test.ts` / `assistant-jev.repo.test.ts`
(seeding, secret upsert/rotate, intent + resolution matrices), and the
service-level suites `server/services/assistant-chat.service.test.ts` and
`assistant-task.service.test.ts`, which fake `fetch` and prove the advisory
reaches the real prompt, resume makes zero Jev calls, every failure mode leaves
the run intact, and Jev emits no `task_activity` of its own.

### Lexa/Assistant — Durable Object runtime (Workers-only)

> **Workers-only (ADR-0003).** The assistant executor is one Durable Object per
> conversation thread, reached over a session-authenticated WebSocket. The
> Bun/Docker flavor mounts no assistant groups (`server/api/http.ts`
> `baseRouteGroups()` only; `assistant-api.ts` is imported solely by
> `server/workers-entry.ts`), so `/api/assistant/*` + `/api/admin/assistant/*`
> 404 there and no `agents` / `@tanstack/ai*` package enters the Bun module
> graph (`server/api/bun-bundle-boundary.test.ts`, `server/api/http-bun-assistant-absent.test.ts`).

- **Agent** — `server/assistant/agent.ts` `LexaAssistantAgent extends AIChatAgent`,
  exported from `server/workers-entry.ts` under binding `ASSISTANT_AGENT`
  (`wrangler.jsonc` `durable_objects` + `new_sqlite_classes` migration). Instance
  name = threadKey `` `${documentType}:${documentId}` `` (`chat|task|wiki`).
  **DO SQLite is canonical** (messages + `thread_meta`, incl. the sticky
  `permission_mode` + import marker); D1
  `assistant_threads` is a per-step **mirror** (list/search/export may lag ≤1
  mirror write). In-flight turns run via `runFiber` + `chatRecovery`, so a turn
  survives isolate eviction/redeploy; a second client queues instead of 409.
- **WS gate** — `server/assistant/agent-gate.ts` is IO-free: session cookie →
  thread ACL (chat owner / project read) → strip every inbound `X-Lexa-*` →
  forward with minted identity + `X-Lexa-Internal: v1:<unix-ts>:<hmac-sha256>`
  headers. Missing master key → 502 `ASSISTANT_UNAVAILABLE`. Constants
  `ASSISTANT_AGENT_ROUTE_PREFIX` / `INTERNAL_ASSISTANT_ROUTE_PREFIX`.
- **Internal routes** — `server/assistant/internal-routes.ts`
  (`handleInternalAssistantRequest`), mounted in `server/workers-entry.ts`
  before the public middleware, authenticated only by the `X-Lexa-Internal` HMAC
  (≤120s skew). Surfaces: legacy import read, mirror write, read-tool execution,
  write-tool proposal, write execution (auto mode), provider config, turn
  context, call-log, run-status.
  Writes that execute approved proposals run through the existing domain
  services (invariant #1 intact); terminal transitions emit activity in the
  same transaction (invariant #12).
- **Inference** — `server/assistant/model-factory.ts` maps a registry row to an
  AI SDK provider, preserves the built-in `x-opencode-session` derivation, walks
  the ≤3 cross-kind fallback, and maps upstream 429 → `PROVIDER_RATE_LIMITED`.
  Tools on AI SDK defs: `server/assistant/tools-ai.ts` (reads; write dispatch is
  mode-dependent) + `write-tools.ts` (proposal validation/diff → D1 pending row).

- **Write-tool permission modes** — per-thread sticky `ask | auto | deny`
  (`thread_meta.permission_mode`, default `ask`, with a guarded
  `PRAGMA table_info` + `ALTER TABLE` upgrade for pre-mode DO stores; the
  resolver lives in `shared/assistant.ts`). The mode is captured at TURN START
  from the DO's sticky value, overridden by the send envelope's
  `permissionMode` (chat threads only — a task/wiki run stays `ask`), and
  persisted back as the new sticky value; a mid-turn change waits for the next
  send (D2/D5/D6). Read tools are unaffected in every mode. Each write call
  consumes one per-turn budget slot where a budget applies: `ask` is capped by
  the Worker-side pending-row count, `auto` by the DO-side counter
  (`MAX_WRITES_PER_TURN`); `deny` consumes none. A bulk call is one slot.
  - `ask` — a write call proposes: a row in `assistant_pending_writes`,
    `tool_pending` frames plus the persisted carrier, and the turn suspends on
    `proposed === true` (below).
  - `auto` — a write call executes immediately through the internal
    `POST /api/internal/assistant/write-execute` route →
    `applyAssistantWrite` (no pending row, no chips, no suspend). The result is
    model-readable (`{ ok, applied, result?, error?, partial? }`); zero applied
    is a tool error, a partially applied bulk still reports `partial`, and a
    transport failure the DO cannot classify is marked `indeterminate` so the
    model does not retry a possibly-applied write.
  - `deny` — a write call returns a structured local refusal
    (`{ ok:false, denied:true, error }`, no Worker call, no row, no suspend).
    Write tools stay offered so the refusal is visible to the model, which may
    suggest switching modes.
  Emissions are unchanged: every task-mutating execution still calls the domain
  services with `viaAssistant` (invariant #12); the other write paths are
  unchanged.
- **Legacy import** — `server/assistant/legacy-convert.ts` converts TanStack
  `ModelMessage[]` → `UIMessage[]` on first DO activation for a thread whose DO
  store is empty and whose D1 row has messages (lossy for tool-internal parts).
- **Capability** — `server/capabilities.ts` `capabilities(flavor, env)` is the
  single `/api/capabilities` contract; `assistant = flavor==='workers' &&
  hasSecretsMasterKey(env)`.
- **REST shell** — the assistant REST handlers live in
  `server/api/assistant-api.ts` (groups in `server/api/assistant-contracts.ts`),
  composed by `createWorkersApiHandler` = base + assistant. The REST tier
  (`AssistantService` / `AssistantChatService` / `AssistantTaskService`, SSE)
  remains mounted on Workers for thread CRUD/admin + the document panel; the
  chat surface uses the DO socket.

### Lexa/Assistant — assistant tier (server-side TanStack AI; Workers-only legacy REST/SSE)

> This tier backs the REST/SSE surface that remains mounted on Workers. The
> chat surface has moved to the Durable Object socket above; the document panel
> still uses it. It is **not** part of the Bun/Docker flavor.

```typescript
export class AssistantTaskService extends Effect.Service<AssistantTaskService>()("Lexa/AssistantTaskService", {
  dependencies: [AssistantTaskRepo.Default, AssistantCatalogRepo.Default, AssistantSettingsRepo.Default,
                 AssistantThreadRepo.Default, AssistantPendingWritesRepo.Default, ProjectMemoryRepo.Default,
                 ActivityService.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default,
                 AssistantGateway.Default, TaskService.Default, CommentService.Default,
                 WikiService.Default, MilestoneService.Default, SwimlaneService.Default,
                 AuthorizationService.Default],
  effect: Effect.gen(function* () {
    return {
      // Queue lifecycle: create/getById/listForDocument/hasRunning/complete/
      //   fail/cancel. Terminal transitions emit assistant_completed|failed|
      //   cancelled inside the SAME withTx as the status write (invariant #12).
      // enqueue: guard provider configured (ProviderNotConfigured), validate
      //   agent/skill/document/attachments, then queueRepo.createTask (queued).
      //   The assistant lane is the only lane; agentId is always the builtin
      //   `assistant` agent, and the enqueued skill must be junction-bound
      //   (`lexa_agent_skills`) — else SkillNotFound.
      // runStream(taskId) → ReadableStream<StreamFrame>: claimAssistantTask
      //   (conditional UPDATE queued→running), assemble prompt, stream chat(),
      //   persist at terminal points; cancel emits no log row.
      // runChatStream(chatId, userId, req): no queue row; one
      //   thread per (project, user); second concurrent stream → AssistantTaskActive.
      //   No skill is bound to the chat thread — skills are invoked per message
      //   (`$name`, ≤3, junction-bound at parse time), discovered via the
      //   bound-skill catalog and the read-only `get_skill` tool.
      // resetThread / testConnection / abortStream / abortChat.
    };
  }),
}) {}
```

- **Provider seam:** `@tanstack/ai` is imported in exactly one file —
  `server/assistant/provider.ts` (adapters `openai_compatible` |
  `anthropic_compatible`, both custom-`baseURL`-capable; `streamChat`,
  `completeText`, `listModels`, `testConnection`, `translateRunError`).
  Routes and services never import the SDK; an upgrade touches two files.
  Pinned exact (`0.47.x`, no caret).
- **Prompt assembly** (`server/assistant/prompt.ts`, cache-friendly order):
  `systemPrompts[0]` identity + markdown contract + `project_memory` block
  (Anthropic `cache_control` breakpoint), `[1]` agent+skill markdown
  (breakpoint), `[2]` prefetched repo content + document context; user
  message carries the instruction (+ rolling-summary segment when present).
  Object form `{content, metadata}` carries `cache_control`.
- **Tools** (`server/assistant/tools.ts`) are declared with
  `toolDefinition().server(fn)` — the read toolset: `web_search` (Exa),
  SSRF-guarded `fetch_url` (allowlist-enforced, PDF-capable),
  `read_s3_file` via `Lexa/Storage`, PM reads (`get_task` accepts the
  `PREFIX-n` alias, `search_tasks`), wiki reads (`search_wiki` FTS-scoped
  to the project, `read_wiki_page` by slug — TipTap→markdown via
  `shared/markdown.ts`, ~8k-char output cap), plus bulk reads
  (`get_all_tasks` — full markdown per task, 60k-char total cap;
  `get_all_wiki_pages` — ~8k per page, 60k total; `get_board_structure` —
  columns/swimlanes/milestones projection); bulk outputs carry
  `truncated: true` when the cap dropped content. Round caps → `AssistantToolBudgetExceeded`: document-task
  streams `MAX_TOOL_ROUNDS=12`; freeform chat `MAX_CHAT_TOOL_ROUNDS=24` (the
  chat toolset chains reads — search_wiki → read_wiki_page → search_tasks —
  so it gets a wider budget; threaded through `StreamRunContext.toolRoundCap`).
- **Write tools** (`server/assistant/write-tools.ts`) are a second toolset,
  gated by `assistant_settings.write_tools` (comma-separated names, parsed by
  `parseWriteTools` — unknown names dropped, duplicates collapse; empty →
  read-only turn). 19 proposal-only tools (`create_task`, `update_task`,
  `move_task`, `archive_task`, `restore_task`, `delete_task`, `add_comment`,
  `create_wiki_page`, `edit_wiki_page`, `delete_wiki_page`, `create_milestone`,
  `update_milestone`, `archive_milestone`, `delete_milestone`, `create_sprint`,
  `update_sprint`, `archive_sprint`, `delete_sprint`, `move_swimlane`) — none
  apply a write directly; each validates refs and
  persists a pending row via `createWriteRecorder` (per-turn budget:
  `MAX_WRITES_PER_TURN=8`; over-budget proposals return a tool error).
  `archive_task` / `restore_task` / `delete_task` also accept
  `refs: string[]` (1..`MAX_BULK_TASK_REFS=100`) as an alternative to the
  single `ref`, so a bulk operation is one proposal and one approval instead
  of one per task — the resolver is all-or-nothing at propose time (any
  unknown ref → `proposed:false` naming it), and the executor applies per
  item, aggregating `{ applied, failed }` (partial success allowed — e.g. the
  delete subtask guard on one task does not abort the rest; zero applied →
  error). Placement on the provider tools nudges `refs` for many tasks.
  Diffs are server-computed plain-text projections (`AssistantWriteDiff` in
  `shared/assistant.ts`, TipTap-aware text extraction, capped) — what the
  approver sees; raw args ride the row for execution. Bulk reuses the existing
  diff type with summary strings (`taskRef: "52 tasks"`, `taskTitle` = first
  up-to-3 keys), so the approval chip target copy stays text, not a new kind.
- **Approval protocol (ask mode):** when a turn queued write proposals, the stream ends
  at the suspend checkpoint instead of `done`: every pending row is emitted
  as a `tool_pending` frame (seq order), the assistant transcript entry is
  persisted with a `pendingBatch` marker — `{ batchId, approvals }` where
  `approvals` pairs each row's `approvalId` with the provider `toolCallId`
  of the write call that proposed it (legacy string shape still read) — and
  the terminal frame is `suspended { batchId }`. The owner decides each row
  via `POST /api/assistant/approvals/:id/decide` (order pinned: sweep → fetch →
  owner check hidden as NotFound → lazy TTL flip → already-decided guard →
  conditional decide). Resume (`POST /api/assistant/chat/:chatId/resume` /
  `POST /api/assistant/threads/:documentType/:documentId/resume`) sweeps TTLs,
  locates the suspended batch via `findPendingBatch` (newest-first scan of
  the transcript, both marker shapes), refuses while approvals are
  outstanding (`APPROVALS_PENDING`), executes approved rows in seq order as
  the assistant actor (per-row domain failures recorded on the row via
  `markExecutionError` — never abort the batch), emits one `approval_result`
  frame per decided row right after the start frame (applied|failed with
  "CODE: message" error for executed rows, denied for rejected rows), clears
  the marker with `applyResumeResults`, and continues the stream from the
  existing transcript (no fresh user entry). Approval TTL is 24h
  (`APPROVAL_TTL_HOURS`, SQL-format `expires_at`) enforced lazily on
  decide/resume/transcript reads — no timer. This propose → pending-row →
  suspend path is ask mode only; in `auto` a write executes immediately and in
  `deny` it is refused locally, so neither reaches the approval protocol (see
  the DO runtime section above).
- **SSE bridge** (`sseHttpResponse` in `server/api/http.ts`): encodes
  StreamFrames as `event:`/`data:` pairs over a raw `HttpServerResponse.stream`
  (bypasses the JSON encoder) with a 15s `: ping` heartbeat comment. Exactly
  one terminal frame (`error`|`done`|`suspended`). Disconnect→abort: the request signal
  is wired into the service's `Map<taskId|chatId, AbortController>`; abort
  discards the partial message and cancels/fails via `AssistantTaskService`.
- **Reasoning frames:** `REASONING_MESSAGE_CONTENT` chunks from reasoning
  models stream as `{ type: "reasoning", delta }` frames, live and in order,
  interleaved with `delta`/`tool` frames. Ephemeral — never persisted into
  `assistant_threads` messages or the rolling summary; the transcript stores only
  the final assistant text. Models without reasoning simply never emit them
  (no capability flag).
- **RUN_ERROR translation:** a `RUN_ERROR` chunk inside the stream is thrown
  through `translateRunError` — recognizable upstream failures map to catalog
  codes (`PROVIDER_AUTH_FAILED`, `PROVIDER_UNREACHABLE`), everything else to
  `ASSISTANT_GENERATION_FAILED`; the frame carries the mapped code, the task is
  failed via `AssistantTaskService.fail`. Upstream bodies never echoed raw.
- **Stall watchdog:** every chunk race in `buildStream`'s consume loop runs
  against a fresh timer (`STREAM_STALL_TIMEOUT_MS = 90_000`, reset on ANY
  chunk). If no chunk arrives for 90s, the provider request is aborted and
  `AssistantGenerationFailed("stream stalled — no response from provider")` is
  thrown — the normal failure path persists the partial text as a failed turn
  (`error` marker) so the UI shows Retry instead of an infinite spinner. The
  watchdog's own abort is flagged (`stalled`) so it is never misclassified as
  a client abort. Wraps both consume calls (document + chat, with/without
  tools).
- **Client-facing error copy:** provider-tagged errors (`ProviderAuthFailed`,
  `ProviderUnreachable`, `AssistantGenerationFailed`) expose only
  `providerMessage` (≤500 chars) or a fixed generic string via
  `clientFacingErrorMessage`; raw upstream text (`raw` / `rawEvent` /
  `upstreamBody`) stays server-log-only. Locally-generated watchdog failures
  (e.g. the stall watchdog) are generic. Untagged errors keep their domain
  message.
- **Tool frame detail:** `tool` frames carry an optional `detail` — a short
  human-readable summary of the call INPUT (≤80 chars), built by
  `toolCallDetail` (`server/assistant/tools.ts`) from the validated args:
  search_wiki → `Searching wiki for "<query>"`, read_wiki_page → `Reading
  wiki page "<slug>"`, search_tasks → `Searching tasks for "<query>"`,
  get_task → `Looking up task <key>`, web_search → `Searching the web for
  "<query>"`, fetch_url → `Fetching <hostname>`, read_s3_file /
  analyze_image → `Reading attachment <name>`.
  *(Pre-ADR-0003 historical note: the DEVIATION below documents the retired
  TanStack AI SSE executor's chunk ordering. The Workers DO runtime above
  (`server/assistant/tools-ai.ts`) is the current tool path; the SSE tool-frame
  detail still applies to the retained legacy document-panel stream.)*
  DEVIATION: TanStack AI emits
  args on `TOOL_CALL_ARGS` chunks AFTER `TOOL_CALL_START` (which carries only
  the name), so both frames are emitted at `TOOL_CALL_END` — call frame first,
  then result — each riding the same detail; unparseable or missing args yield
  no detail (name-only frames).
- **Thread persistence floor:** `assistant_threads` rows are read/written only
  through `AssistantThreadRepo.loadThread(doc)` / `saveThread(doc, patch)` —
  called directly at the terminal points (post-`done` persist, enqueue-time
  attachment pre-save, reset). A future D1 swap touches the repo only.
  Continue-vs-fresh: same doc + same agentId + existing row → continue;
  anything else → fresh overwrite. A chat thread carries no skill binding —
  `$name` skills are per-message (≤3, junction-bound at parse time, discovered
  via the catalog + `get_skill`) — so changing one never resets history.
  Model/provider changes never reset a thread.
- **No new services for chat upgrades:** edit/regenerate/retry
  (`truncateChatFrom`), pinning/list metadata (`updateChatMeta`, `listChats`)
  and citation collection stay INSIDE `AssistantService` +
  `AssistantThreadRepo` — no new Effect services/layers. Citations ride the
  existing tool deps (`AssistantToolDeps.onCitation` callback) and are persisted
  inline in the transcript JSON; there is no citations table.
- **Rolling summary:** after `done`, if messages >40 entries or >64KB text
  bytes → summarize all-but-last-8 into `summary` (cheap completion call),
  truncate the window to the last 8. Summary failure logs and skips — retried
  next turn, never blocks `done`.
- **Chat mention resolution:** the composer sends plain `@token` strings; the
  server scans them at send (`scanMentionTokens`) and resolves each to a task
  (key or `PREFIX-n` alias) or wiki page in the sender's project — on
  ambiguity the task-key reading wins. Caps (`MENTION_CAPS`: ≤5 resolved
  mentions per message, ≤4000 chars per document, ≤20000 total) are enforced
  by silent truncation, never errors. Resolved context rides an ephemeral
  system-prompt segment — never persisted to the thread, so transcripts stay
  byte-stable across turns.
- **Vision resolution chain** (two outcomes; `vision_model` delegation
  removed in the squashed baseline — columns kind/base_url/api_key/model/vision_model
  dropped, legacy compat check remains but never fires):
  1. `primary_supports_images=1` → inline image parts on the primary model.
  2. else attachments are rejected up front with `VisionNotConfigured`
     (409) — never a mid-stream failure.
- **One builtin agent:** the single builtin seed constant is `assistant`
  ("Assistant Agent", companion-persona instructions), mirrored by the rebinding
  SQL in `0005_runtime_rename.sql`/`0006_assistant_rename.sql`. The former
  `blacksmith` coding agent is deleted by `0008_remove_agent_runtimes.sql`.
  Skill availability per agent = `lexa_agent_skills` junction rows only
  (admin-editable); no JSON columns.

### API middleware

One `HttpApiBuilder.middleware` wraps the whole router (pre-routing, before decode). Order: **rate limit → content-length pre-check → auth → security headers**. Rules:

- **Literal short-circuits only.** Return `HttpServerResponse.unsafeJson(...)` for 429/413/401/403 — never `Effect.fail` with an undeclared error. In @effect/platform 0.97 the error encoder cannot encode undeclared failures → raw cause → 500 trap.
- **`AuthIdentity` is provided, not re-fetched.** Middleware resolves the caller ONCE — session cookie first (`SessionService.userFrom`, try/catch), Bearer key fallback (`resolveApiKeyIdentity(authHeader, db)`) — on the *shared* Sqlite connection and `Effect.provideService`s the tag; handlers/`requireSuperadmin` read it. Per-request DB opens are banned (they cost 3 PRAGMAs each). `/api/auth/*` is mounted BEFORE this middleware (Better Auth handler owns that path).
- **Socket IP lives only in entry.** `remoteAddress` is unpopulated on the web-handler path, so entry stamps `x-lexa-remote-ip` (deleting any inbound value first — spoof guard) on the reconstructed request. Middleware resolves the limiter key with `resolveClientIp(peer, cf-connecting-ip, trustedProxyCidrs)` (`server/api/rate-limit.ts`): `cf-connecting-ip` is honored **only** when the peer is loopback (`127.0.0.0/8`, `::1`, v4-mapped) or matches `LXK_TRUSTED_PROXY_CIDRS` (comma-separated IPv4/IPv6 CIDRs or bare IPs; unset/empty = loopback only, resolved by `resolveTrustedProxyCidrs` in `server/env.ts`). Otherwise the peer/socket IP wins — a private non-loopback client cannot pick a fresh bucket with a spoofed header. On Workers there is no socket address: `workersClientIp` deletes any inbound `x-lexa-remote-ip` before resolving, so a leaked/forged stamp cannot be mistaken for a peer and `cf-connecting-ip` (set by Cloudflare's edge) is the source. The Bun entry's `/api/auth/*` throttle (`server/entry.ts`) uses the same helper.
- **Exemptions are path predicates inside the middleware**: `/api/setup*` + `/api/health` skip AUTH only (they stay rate-limited); `/api/share/*` skips AUTH only too (public wiki-share capability URLs — still rate-limited with a dedicated stricter bucket, security headers kept; handlers must not consume `AuthIdentity`, since exempt paths receive a synthetic identity). `isRateLimitExemptPath` now returns `false` for every path — the removed runtime daemon surfaces were the only exemption.
- **Assistant Worker-gate mounts sit before the key middleware (Workers only).** `GET /api/capabilities` (no auth, no DB), `GET /api/assistant/agent/:threadKey` (session-cookie WS upgrade), and `/api/internal/assistant/*` (`X-Lexa-Internal` HMAC derived `HMAC(LXK_SECRETS_MASTER_KEY, "lexa-internal-v1")`, ≤120s skew) are handled in `server/workers-entry.ts` before `handleApi`; the public middleware would otherwise demand an API key. The gate strips inbound `X-Lexa-*` and mints the signed identity headers. These are Workers-only — the Bun handler mounts none of them.
- **Rate limiting shares one bucket** (`apiRateLimiter` singleton; `/api/share/*` excepted — it applies a dedicated stricter per-IP bucket so the public unauthenticated surface cannot exhaust the shared one) and runs before auth — a blocked IP stays blocked regardless of key. Limits are DB-configured (`GET`/`PUT /api/settings/rate-limit`, admin-only): **DB settings (`settings.rate_limit_max` / `settings.rate_limit_window_ms`) with the code defaults (6000 / 600_000 ms) as fallback** — `resolveRateLimitFromDbValues` in `server/api/rate-limit.ts`. The DB is the single source of truth: env (`LXK_RATE_LIMIT_MAX` / `LXK_RATE_LIMIT_WINDOW_MS`) is a first-boot bootstrap, mirrored into the DB once at boot by `mirrorSettingsFromEnv` (server/db/settings.ts) when keys are empty, and never consulted at runtime. `syncRateLimitFromDb` applies the DB values at boot (after the mirror) and on save, so changes take effect live without a restart (existing buckets keep their windowStart and expire against the new window).
- **Router 404s** fail with `RouteNotFound` after the middleware; caught inside so 404s carry the security headers (empty body, platform-identical shape).
- **`MaxBodySize` is unenforced in 0.97** — the authoritative body cap is entry's stream cap (`readBodyWithLimit`); the middleware pre-check is a declared-length fast-path only.

## Pagination

All list endpoints: `?limit` (default 50, max 200) + cursor (opaque: `"<columnId>:<position>:<taskId>"` for tasks). Unbounded lists would blow the server memory.

## TaggedErrors Catalog (v2)

| Error | HTTP | Notes |
|-------|------|-------|
| `TaskNotFound` | 404 | |
| `ProjectNotFound` | 404 | |
| `ColumnNotFound` | 404 | |
| `SwimlaneNotFound` | 404 | incl. cross-project refs |
| `WikiPageNotFound` | 404 | |
| `WipLimitExceeded` | 409 | atomic, from conditional UPDATE (not fired by within-column reorders) |
| `DeadlineAfterLane` | 409 | card dueAt later than its lane's due (create/update/move without clearDueAt; lane dueAt shrunk past a live card's deadline) — payload `{ date, taskId?, taskTitle? }` |
| `BacklogProtected` | 409 | archive/delete/deadline on the system Backlog lane — payload `{ action }` |
| `SlugTaken` | 409 | SQLITE_CONSTRAINT on projects.slug or wiki_pages(project_id, slug); also the constraint fallback on project update/delete |
| `HasChildren` | 409 | column delete with tasks; wiki-page delete with children |
| `InvalidParent` | 422 | wiki reparent: self, cross-project, or descendant cycle (details: `{ reason }`) |
| `TaskHasChildren` | 409 | task delete hits a constraint (defensive — subtask links CASCADE) |
| `NeighborNotInColumn` | 422 | beforeTaskId/afterTaskId not in target column |
| `GithubIssueAlreadyLinked` | 409 | |
| `RequiredFieldMissing` | 422 | TipTap-aware emptiness; enforced on create/move/update |
| `OptionInUse` | 409 | delete priority/type option still referenced by tasks |
| `InvalidOption` | 422 | unknown/foreign option id, duplicate label, or empty list |
| `SourceNotFound` | 404 | delete a source that doesn't exist |
| `SourceFetchError` | 422 | bad URL / SSRF-guard block / unreadable page |
| `SourceUnreachable` | 422 | fetch failed (timeout, DNS, network) |
| `AssistantTaskNotFound` | 404 | |
| `AgentNotFound` | 404 | unknown assistant agent (task create) |
| `SkillNotFound` | 404 | unknown assistant skill (task create / bindings) |
| `AgentBuiltinDelete` | 422 | delete/reset-guard on a builtin agent/skill |
| `AgentEntityInUse` | 409 | delete agent/skill still referenced by assistant tasks |
| `TeamHasProjects` | 409 | delete team while it owns projects — reassign first (payload `{ count }`) |
| `SoleOwner` | 403 | demoting/removing the last owner of a team — transfer ownership first (payload `{ message }`) |
| `CannotDeleteSelf` | 403 | removing the last superadmin / self-removal via the workspace member routes |
| `TaskLinkNotFound` | 404 | delete a link that doesn't exist |
| `TaskLinkCycle` | 409 | subtask_of would create a cycle |
| `InvalidTaskLink` | 422 | self-link or cross-project link |
| `ConstraintViolation` | 409 | internal; `isPositionConflict` variants are retried (create/move) before surfacing |
| `DbError` | 500 | |
| `GithubApiError` | 502 | never fails a user move |
| `GithubWebhookError` | 400 | bad signature → 401 |
| `InvalidKey` / `MissingAuth` | 401 | REST emits `UNAUTHORIZED` instead (see note below) |
| `UserNotFound` | 404 | unknown user id on admin/workspace role endpoints |
| `NoUserContext` | 400 | `PATCH /api/me` called with a bare API key (no session) — agents have no profile |
| `MilestoneNotFound` | 404 | incl. cross-project refs (swimlane sprint fields) |
| `InvalidArgs` | 422 | swimlane sprint validation: `startAt > dueAt` |
| `ApiKeyNotFound` | 404 | settings — key id that doesn't exist |
| `ApiKeyNameEmpty` | 422 | create key with no name (`server/services/api-key.service.ts`) |
| `Forbidden` | 403 | admin/settings gates — also the code for `ProjectAccessDenied` |
| `SetupLocked` | 403 | wizard on an already-configured install |
| `SearchError` | 422 | invalid search query |
| `TeamNotFound` | 404 | |
| `TeamMemberNotFound` | 404 | unknown user on team membership routes |
| `MemberNotInWorkspace` | 422 | add a non-member to a team |
| `InviteNotFound` | 404 | unknown/expired workspace invite |
| `InviteAlreadyPending` | 409 | duplicate invite for the same email |
| `SessionNotFound` | 404 | unknown session id on session routes |
| `TeamSlugTaken` | 409 | team slug collision |
| `WorkspaceUserNotFound` | 404 | unknown user on workspace routes |
| `PasswordLinkIssueFailed` | 500 | admin set-password link issue failed — no `errorToStatus` case, falls to default 500 |
| `InvalidName` | 422 | invalid team/user name |
| `InvalidRateLimit` | 422 | bad rate-limit settings payload |
| `InvalidGithubSettings` | 422 | bad GitHub App settings payload |
| `ProjectAccessDenied` | 403 | `user_project_roles`/team grant check failed |
| `CommentNotFound` | 404 | |
| `CommentEditForbidden` | 403 | edit another user's comment |
| `CommentDeleteForbidden` | 403 | delete without author/admin authority |
| `CommentInvalid` | 422 | invalid body (empty TipTap doc / >64KB) |
| `AttachmentNotFound` | 404 | unknown attachment id, or blob missing, or attachment outside the shared subtree on the share route |
| `PayloadTooLarge` | 413 | upload exceeds `LXK_MAX_UPLOAD_MB` (default 25) — route-level cap; the global body cap stays `BODY_TOO_LARGE` |
| `AttachmentDeleteForbidden` | 403 | delete without uploader/admin authority |
| `ShareLinkNotFound` | 404 | wiki share link resolve/revoke: unknown, expired, and revoked all fail identically (no existence oracle) |
| `ProviderNotConfigured` | 409 | Assistant generate/test/chat without saved provider settings for the project |
| `ProviderAuthFailed` | 502 | upstream 401/403 (provider or Exa) |
| `ProviderUnreachable` | 502 | provider network/timeout/DNS failure |
| `AssistantGenerationFailed` | 502 | RUN_ERROR catch-all, malformed stream, or recovery exhausted |
| `AssistantToolBudgetExceeded` | 502 | tool round cap hit (document tasks `MAX_TOOL_ROUNDS=12`, freeform chat `MAX_CHAT_TOOL_ROUNDS=24`) |
| `AssistantUnavailable` | 502 | DO unreachable, DO RPC failed, legacy import failed after retry, or an internal route failed — Workers only |
| `ProviderRateLimited` | 429 | AI Gateway / Workers AI rate limit (including the guarded-model 20 rpm ceiling) |
| `AssistantTaskActive` | 409 | enqueue race on an `assistant_tasks` row, or thread reset while a run is claimed. A second chat client on a live thread no longer raises this — the DO serializes and queues |
| `AssistantThreadNotFound` | 404 | missing thread row (`assistant_threads`), or the WS gate refusing a thread that is missing / not owned / not project-readable |
| `VisionNotConfigured` | 409 | attachments submitted while `primary_supports_images=0` (vision_model delegation removed in the squashed baseline) |
| `ApprovalNotFound` | 404 | unknown approval id, or not the pending row's owner (owner mismatch hidden as NotFound) |
| `ApprovalExpired` | 409 | decide on a row past its 24h TTL — lazily flipped to `expired` first |
| `ApprovalAlreadyDecided` | 409 | second decision on a decided/expired row — payload `{ id, status }` |
| `ApprovalsPending` | 409 | resume while rows in the batch are still undecided — payload `{ batchId, remaining }` |
| `ToolDenied` | 403 | write-tool execution refused by authorization at resume time |
| `McpServerNotFound` | 404 | MCP registry: unknown server id (update/delete/test/project availability) |
| `McpInvalidTransportConfig` | 400 | `stdio` transport, `command`/`args` on a remote transport, transport shape mismatch, bad url, an SSRF-blocked host, a managed token with no master key, or `clearSecret` combined with a value |
| `McpStdioUnavailable` | 400 | reserved, no longer emitted — stdio clients were removed (migration 0010); kept so an older stored code still maps to a response |
| `McpConnectFailed` | 502 | MCP connector could not connect or `tools/list` failed (folded into the test report); also a legacy stored `secret_ref` or an undecryptable managed blob — never a silent anonymous connect |
| `McpToolCallFailed` | 502 | MCP tool invocation failed (tool-loop phase) |

Note: `RowNotFound` (server/db/database.ts) is a repo-level error with no
`errorCodeMap` entry — if it ever reaches the HTTP error encoder it falls to
`INTERNAL` / 500.

Defined in the error map but never raised by any REST handler — do not match on them: `INVALID_API_KEY` / `MISSING_AUTH` (the auth middleware emits `UNAUTHORIZED` — see the Auth section).

**Client-side only (never a server REST code):** `ASSISTANT_CONNECTION_LOST` — the
assistant WebSocket adapter surfaces it while the socket is reconnecting
(`app/lib/assistant-agent-adapter.ts`); the socket auto-resumes and the marker
clears. Do not match on it server-side.

## Service Dependency Map

```
TaskService        → TaskRepo, ColumnRepo, SwimlaneRepo, ProjectRepo, FieldConfigRepo, ActivityService
FieldConfigService → FieldConfigRepo, ProjectRepo
AssistantCatalogService → AssistantCatalogRepo, AssistantTaskRepo
AssistantTaskService  → AssistantTaskRepo, AssistantCatalogRepo, AssistantSettingsRepo, AssistantThreadRepo, AssistantPendingWritesRepo, ProjectMemoryRepo, ActivityService, Storage, TaskRepo, WikiRepo, AssistantGateway, TaskService, CommentService, WikiService, MilestoneService, SwimlaneService, AuthorizationService (never GitHubService — approved writes run through the domain services)
AssistantService      → AssistantChatService, AssistantTaskService (thin facade — delegates; see §Lexa/Assistant) [Workers-only REST/SSE legacy]
LexaAssistantAgent (DO) → model-factory, tools-ai, write-tools, prompt, vision, mcp, jev, legacy-convert (Workers-only; calls the Worker internal routes for reads/writes, never GitHubService directly)
AssistantMcpService   → AssistantMcpRepo, McpConnector, + server/assistant/mcp-secret.ts (PLAIN module, not a service — crypto only, no DB, no deps) (no service/repo cycles; never GitHubService or chat services)
SourceService      → SourceRepo, ProjectRepo, WikiRepo, ActivityService
TaskLinkService    → TaskLinkRepo, TaskRepo, ProjectRepo, ActivityService
WikiService        → WikiRepo, ProjectRepo
WikiShareService   → WikiShareRepo, WikiRepo
ProjectService     → ProjectRepo, ProjectReposRepo, ColumnRepo, SwimlaneRepo, FieldConfigRepo
ColumnService      → ColumnRepo, ProjectRepo
SwimlaneService    → SwimlaneRepo, ProjectRepo, TaskRepo, ActivityService
MilestoneService   → MilestoneRepo, SwimlaneRepo, TaskRepo, ProjectRepo, ActivityService
ActivityService    → ActivityRepo, CommentRepo
CommentService     → CommentRepo, ActivityRepo, TaskRepo, UserProjectRoleRepo
AttachmentService  → AttachmentRepo, Storage, TaskRepo, WikiRepo, UserRepo, UserProjectRoleRepo, ActivityService
DashboardService   → ProjectRepo, ProjectReposRepo, ColumnRepo, TaskRepo
SessionService     → (Better Auth `auth` instance — getSession wrapper, try/catch)
AuthorizationService → (no service/repo deps — raw SQLite only)
GitHubService      → GitHubClient, WebhookEventRepo, TaskRepo, ProjectRepo, ProjectReposRepo, TaskService, ProjectService, ColumnRepo, ActivityService
Routes            → all services (orchestration layer — the only place
                     TaskService and GitHubService meet; content push is
                     called from REST updateTask)
```

**Runtime team inference (removed).** `RuntimeService.registerRuntime`'s team
inference was deleted with the runtime tier. Teams still gate project access,
but there are no team-scoped runtimes and no `TEAM_HAS_RUNTIMES` delete guard.
