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
│  WikiShareService                                        │
│  GitHubService ──depends on──▶ TaskService               │
│                        + ProjectService (webhooks)       │
├─────────────────────────────────────────────────────────┤
│                 Repository Layer                         │
│  TaskRepo  ProjectRepo  WikiRepo  ColumnRepo            │
│  SwimlaneRepo  MilestoneRepo  ApiKeyRepo  WebhookEventRepo │
│  WikiShareRepo                                           │
├─────────────────────────────────────────────────────────┤
│               Infrastructure Layer                       │
│  Sqlite (bun:sqlite)   GitHubClient   Config (env)      │
└─────────────────────────────────────────────────────────┘
```

**The v1 cycle is gone — no bidirectional service cycles:** `TaskService` never depends on `GitHubService`. The service-to-service edges that exist are all one-way: `GitHubService → TaskService` (+ `ProjectService`, used by webhook handling); `WorkspaceService → WorkspaceInvitesService, PasswordLinksService`; `RuntimeMachineService → RuntimeEventService`; `ForgeService → SourceService`; and `TaskService`, `TaskLinkService`, `SourceService` (+ `GitHubService`) → `ActivityService`. Lexa→GitHub sync is orchestrated by the route layer after a successful move. GitHubService also depends on `ProjectService` (workspace-repo validation, issue listing); content push is service-internal but stays GitHub-side — the route layer still owns move-time state sync.

## Infrastructure

```typescript
// The SQLite connection is created at boot from DATABASE_PATH and injected
// as a layer (server/db/database.ts). One connection, WAL mode, FK pragmas on.
export class Sqlite extends Context.Tag("Lexa/Sqlite")<Sqlite, Database>() {}
export const initSqlite = (dbPath: string) => Layer.succeed(Sqlite, new Database(dbPath));

// GitHub App credentials — the settings DB is the SINGLE source of truth at
// runtime (settings.github_app_id / settings.github_private_key /
// settings.github_webhook_secret). Env (GITHUB_APP_ID / GITHUB_PRIVATE_KEY /
// GITHUB_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET) is a FIRST-BOOT BOOTSTRAP
// only: mirrorSettingsFromEnv copies it into the DB once at boot when keys
// are empty (GITHUB_PRIVATE_KEY inline wins over the file; the file is read
// at mirror time), and the runtime never reads env again.
// GitHubConfigLive serves a MUTABLE module-scope holder (never replaced):
// syncGitHubConfigFromDb (boot + PUT /api/settings/github) mutates it in
// place, so every consumer — including the webhook verifier runtime — reads
// live values on each call. resetGithubCaches() drops cached installation
// ids/tokens after a save (a credential change must not keep signing with
// the previous app).
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
// Keys have full read/write — no scopes (single-agent trust model,
// documented). SHA-256 lookup; last_used_at sampled (only when NULL or
// older than 1h — avoids a write per API call).
export function resolveApiKeyIdentity(authHeader: string, headers: Headers, db: Database, dbPath: string): ApiKeyIdentity | null {
  // "lxk_" prefix + /^lxk_[0-9A-Za-z]{43}$/ shape check → sha256 →
  // api_keys.key_hash lookup; unbound keys (no user_id) resolve to role
  // 'admin'. Returns null on any failure → the middleware denies 401.
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
// config, Forge agents/skills, security are no longer 'admin'-gated;
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

**Content-sync emission:** the Lexa→GitHub content push (`syncContentFromLexa`)
emits NOTHING — it runs after the mutation commits and the mutation's
`field_changed` rows stand alone. Webhook-applied edits (external GitHub
edits pulled in by the `edited` handler) DO emit `field_changed` rows (actor
system/'github') in the same transaction as the update — the invariant holds
in both directions.

**Actor resolution (attribution ≠ authorization):** browser users → the
Better Auth session user (`actorFromIdentity` maps it to kind 'user'); API
keys → kind 'agent' with the key's NAME as label and the key owner's
user id (unbound keys → NULL); webhook moves → kind 'system', label
'github'; Forge terminal events → kind 'agent', label = forge agent name
(agent_id fallback). The legacy `x-lxk-user` header is gone — attribution
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

### Forge claim — repoContent delivery

On `POST /api/forge/daemon/claim` the handler assembles the claim: task, runtime config, server-built prompt, agent/skill rule files, and — best-effort — the task's linked GitHub repo content (`repoContent: [{ owner, repo, path, content }]`, `[]` when none). The daemon writes those files into `repo-content/` (+ `MANIFEST.md`) and the prompt points the agent there ("Linked GitHub repo content is in the repo-content/ directory…").

- **Sources:** the project's `project_repos` rows with `source_role = 1` → repo values ("owner/repo"), capped at the `forge_repo_cap` setting (env bootstrap `LXK_FORGE_REPO_CAP`, default 3), only when `documentType === "task"`. Task-linked issue repos no longer feed context.
- **Pipeline (per repo):** `GitHubClient.getDefaultBranch` → `getRepoFileTree(recursive=1)` → pure `selectRepoFiles` (`server/github/repo-content.ts`: skips node_modules/.git/dist/build/vendor/.next/coverage/target/.venv dirs, lockfiles, `*.min.js`/`*.min.css`/`*.map`, true binaries — svg stays; caps 50 files / 256 KB per file / 512 KB total, respecting tree sizes without fetching) → `getRepoFileContent` (per-segment URL-encoded path, base64 → UTF-8). Content truncated to 256 KB per file at assembly; total byte cap enforced across repos.
- **Never fails the claim:** every failure (unconfigured app, missing repo, network, per-file) is caught per repo/file, logged `WARN`, and skipped — `repoContent` ends up `[]` and the claim still returns 200. The prompt's repo-content line is added only when `repoContent` is non-empty (`buildPromptForTask(task, hasRepoContent)`).

### API middleware

One `HttpApiBuilder.middleware` wraps the whole router (pre-routing, before decode). Order: **rate limit → content-length pre-check → auth → security headers**. Rules:

- **Literal short-circuits only.** Return `HttpServerResponse.unsafeJson(...)` for 429/413/401/403 — never `Effect.fail` with an undeclared error. In @effect/platform 0.97 the error encoder cannot encode undeclared failures → raw cause → 500 trap.
- **`AuthIdentity` is provided, not re-fetched.** Middleware resolves the caller ONCE — session cookie first (`SessionService.userFrom`, try/catch), Bearer key fallback (`resolveApiKeyIdentity(authHeader, db)`) — on the *shared* Sqlite connection and `Effect.provideService`s the tag; handlers/`requireSuperadmin` read it. Per-request DB opens are banned (they cost 3 PRAGMAs each). `/api/auth/*` is mounted BEFORE this middleware (Better Auth handler owns that path).
- **Socket IP lives only in entry.** `remoteAddress` is unpopulated on the web-handler path, so entry stamps `x-lexa-remote-ip` (deleting any inbound value first — spoof guard) on the reconstructed request; middleware applies the `isPrivateIp`-gated `cf-connecting-ip` trust.
- **Exemptions are path predicates inside the middleware**: `/api/setup*` + `/api/health` skip AUTH only (they stay rate-limited); `/api/share/*` skips AUTH only too (public wiki-share capability URLs — still rate-limited with a dedicated stricter bucket, security headers kept; handlers must not consume `AuthIdentity`, since exempt paths receive a synthetic identity); `/api/forge/daemon/*` + `/api/forge/runtimes/register` + `/api/forge/machines/heartbeat` accept the daemon token where applicable and are rate-limit-exempt (key/token-gated machine surfaces — log streams and the 3s heartbeat must not 429).
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
| `TaskHasChildren` | 409 | task delete hits a constraint (defensive — subtask links CASCADE) |
| `NeighborNotInColumn` | 422 | beforeTaskId/afterTaskId not in target column |
| `GithubIssueAlreadyLinked` | 409 | |
| `RequiredFieldMissing` | 422 | TipTap-aware emptiness; enforced on create/move/update |
| `OptionInUse` | 409 | delete priority/type option still referenced by tasks |
| `InvalidOption` | 422 | unknown/foreign option id, duplicate label, or empty list |
| `SourceNotFound` | 404 | delete a source that doesn't exist |
| `SourceFetchError` | 422 | bad URL / SSRF-guard block / unreadable page |
| `SourceUnreachable` | 422 | fetch failed (timeout, DNS, network) |
| `ForgeTaskNotFound` | 404 | |
| `AgentNotFound` | 404 | unknown forge agent (task create / claim resolve) |
| `SkillNotFound` | 404 | unknown forge skill (task create / bindings) |
| `ForgeBuiltinDelete` | 422 | delete/reset-guard on a builtin agent/skill |
| `ForgeEntityInUse` | 409 | delete agent/skill still referenced by forge tasks |
| `NoRuntimeOnline` | 409 | create Forge task with no daemon up |
| `MachineNotFound` | 404 | unknown machine target |
| `MachineIdTaken` | 409 | register: id bound to another host, legacy (no secret), or secret mismatch (details: `{ id, reason }`) |
| `MachineSecretMismatch` | 403 | runtime-event claim without a matching machine secret — identical response for missing machine/legacy/wrong secret (no existence oracle) |
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
| `RuntimeNotFound` | 404 | unknown forge runtime target |
| `RuntimeEventNotFound` | 404 | unknown runtime setup event |
| `ApiKeyNotFound` | 404 | settings — key id that doesn't exist |
| `ApiKeyNameEmpty` | 422 | create key with no name (`server/services/api-key.service.ts`) |
| `Forbidden` | 403 | admin/settings gates — also the code for `ProjectAccessDenied` / `MachineSecretMismatch` |
| `SetupLocked` | 403 | wizard on an already-configured install |
| `SearchError` | 422 | invalid search query |
| `ForgeSessionActive` | 409 | document already has an active forge task |
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
| `ShareLinkNotFound` | 404 | wiki share link resolve/revoke: unknown, expired, and revoked all fail identically (no existence oracle) |

Note: `RowNotFound` (server/db/database.ts) is a repo-level error with no
`errorCodeMap` entry — if it ever reaches the HTTP error encoder it falls to
`INTERNAL` / 500.

Defined in the error map but never raised by any REST handler — do not match on them: `INVALID_API_KEY` / `MISSING_AUTH` (the auth middleware emits `UNAUTHORIZED` — see the Auth section).

## Service Dependency Map

```
TaskService        → TaskRepo, ColumnRepo, SwimlaneRepo, ProjectRepo, FieldConfigRepo, ActivityService
FieldConfigService → FieldConfigRepo, ProjectRepo
ForgeService       → ForgeRepo, ForgeSessionRepo, SourceRepo, SourceService, TaskRepo, WikiRepo, ProjectRepo, ActivityService
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
DashboardService   → ProjectRepo, ProjectReposRepo, ColumnRepo, TaskRepo
SessionService     → (Better Auth `auth` instance — getSession wrapper, try/catch)
AuthorizationService → (no service/repo deps — raw SQLite only)
GitHubService      → GitHubClient, WebhookEventRepo, TaskRepo, ProjectRepo, ProjectReposRepo, TaskService, ProjectService, ColumnRepo, ActivityService
Routes            → all services (orchestration layer — the only place
                     TaskService and GitHubService meet; content push is
                     called from REST updateTask)
```
