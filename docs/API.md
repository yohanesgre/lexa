# REST API Contract (v1)

> Derived from ARCHITECTURE.md (v2.1) routes and LAYERS.md (v2.1) services. This is the frontend↔backend contract. For the agent-facing contract see MCP.md.

## Conventions

| Concern | Convention |
|---------|-----------|
| Base URL | `https://<host>/api` (Bun server behind the cloudflared tunnel) |
| Auth (machine) | `Authorization: Bearer lxk_<43 base62 chars>` — required by every `/api/*` route except `/api/health`, `/api/setup/*`, the GitHub webhook (HMAC), and `/api/forge/runtimes/register` + `/api/forge/daemon/*` routes carrying `x-forge-token` (see Auth) |
| Auth (human) | Cloudflare Access terminates at the edge (Google OAuth). With `LXK_ACCESS_AUD` set, the server verifies the `Cf-Access-Jwt-Assertion` against the team JWKS (`server/api/access-auth.ts`) and upserts users from the claims; without it, it trusts `Cf-Access-Authenticated-User-Email` / `Cf-Access-Authenticated-User-Name` headers (tunnel-authenticated, boot warning). Page (SSR) user provisioning only — the REST API itself is machine-key only. |
| Content type | `application/json; charset=utf-8` |
| IDs | UUID strings |
| Timestamps | ISO 8601 UTC (`2026-07-27T10:30:00Z`) |
| Rich text | **TipTap/ProseMirror JSON object** on REST. (Markdown only exists at the MCP boundary — see MCP.md §Content Format.) |
| Pagination | `?limit` (default 50, max 200) + `?cursor` (opaque). Response envelope: `{ "data": [...], "nextCursor": string \| null }`. **Exception: `/board` is unpaginated.** |
| Slug generation | Server auto-slugifies `title`/`name` when `slug` is omitted; collisions → `SlugTaken` (client may retry with explicit slug) |

## Error Envelope

All non-2xx responses share one shape:

```json
{
  "error": {
    "code": "WIP_LIMIT",
    "message": "Column 'In Progress' is at its WIP limit of 4",
    "details": { "column": "In Progress", "limit": 4, "current": 4 }
  }
}
```

| HTTP | Code | When |
|------|------|------|
| 400 | — | Payload schema validation failures are rejected by the platform before handlers run; the body is the platform's response, not the envelope above. No domain code maps to 400. |
| 401 | `UNAUTHORIZED` | Missing or invalid API key (auth middleware in `server/api/middleware.ts`; see Auth) |
| 401 | `GITHUB_WEBHOOK_ERROR` | Webhook signature mismatch (before body parsing) |
| 403 | `FORBIDDEN` | Admin-only endpoint called by a non-admin, project access denied (details: `{ message }`), or machine-secret mismatch on runtime-event claim |
| 403 | `SETUP_LOCKED` | Mutating `/api/setup/*` call after setup is complete or projects exist |
| 403 | `CANNOT_DELETE_SELF` | Demoting or removing the last admin via the admin user routes (details: `{ message }`) |
| 404 | `USER_NOT_FOUND` | Unknown user id on admin role endpoints |
| 404 | `PROJECT_NOT_FOUND` `COLUMN_NOT_FOUND` `SWIMLANE_NOT_FOUND` `TASK_NOT_FOUND` `PAGE_NOT_FOUND` `SOURCE_NOT_FOUND` `FORGE_TASK_NOT_FOUND` `TASK_LINK_NOT_FOUND` `MACHINE_NOT_FOUND` `RUNTIME_NOT_FOUND` `RUNTIME_EVENT_NOT_FOUND` `API_KEY_NOT_FOUND` `AGENT_NOT_FOUND` `SKILL_NOT_FOUND` | |
| 409 | `SLUG_TAKEN` | Duplicate project slug or wiki slug (details: `{ slug }`); also the constraint fallback on project update/delete |
| 409 | `MACHINE_ID_TAKEN` | Machine id already registered to another host, legacy (no secret), or secret mismatch (details: `{ id, reason: "hostname" \| "legacy" \| "secret_mismatch" }`) |
| 409 | `TASK_HAS_CHILDREN` | Task delete hits a constraint (defensive — subtask links cascade on delete) |
| 409 | `NO_RUNTIME_ONLINE` | Create Forge task with no daemon online |
| 409 | `TASK_LINK_CYCLE` | subtask_of link would create a cycle (details: `{ message }`) |
| 409 | `HAS_CHILDREN` | Delete column with tasks / wiki page with children (details: `{ count }`) |
| 409 | `WIP_LIMIT` | Move would exceed column WIP limit |
| 409 | `ALREADY_LINKED` | Task already has a GitHub issue in that repo |
| 409 | `OPTION_IN_USE` | Delete priority/type option still referenced by tasks (details: `{ optionId, label }`) |
| 409 | `FORGE_ENTITY_IN_USE` | Delete agent/skill still used by forge tasks (details: `{ kind, name, count }`) |
| 409 | `CONSTRAINT` | Generic constraint-violation fallback (typed codes like `SLUG_TAKEN` / `HAS_CHILDREN` / `OPTION_IN_USE` are raised whenever possible) |
| 409 | `LAST_ADMIN_DEMOTE` | Demote/remove would leave the instance with no admin |
| 413 | `BODY_TOO_LARGE` | Request body exceeds `LXK_MAX_BODY_MB` (default 16) — early gates, before auth: stream cap in `server/entry.ts` (chunked/CL-less bodies included) + declared-length pre-check in the API middleware |
| 422 | `REQUIRED_FIELD` | Column's `required_fields` not satisfied (details: `{ field, column }`) |
| 422 | `NEIGHBOR_NOT_IN_COLUMN` | `beforeTaskId`/`afterTaskId` not in target column (details: `{ taskId }`) |
| 422 | `INVALID_OPTION` | Unknown priority/type option id, duplicate label, or empty option list (details: `{ optionId? }`) |
| 422 | `INVALID_TASK_LINK` | Self-link or cross-project task link (details: `{ message }`) |
| 422 | `FORGE_BUILTIN_DELETE` | Delete/reset of a builtin agent or skill (details: `{ kind, name }`) |
| 422 | `SEARCH_ERROR` | Wiki FTS5 query rejected |
| 422 | `SOURCE_UNREACHABLE` | External source DNS/fetch failed after the SSRF guard (details: `{ url }`) |
| 422 | `API_KEY_NAME_EMPTY` | API key name missing or blank |
| 429 | `RATE_LIMITED` | Per-IP rate limit exceeded on `/api/*` or `/mcp` (webhook, `/api/forge/daemon/*`, `/api/forge/runtimes/register` exempt; `/api/setup*` + `/api/health` ARE limited) — `/api` enforced in the API middleware, `/mcp` in `server/entry.ts`, one shared bucket |
| 500 | `DATABASE_ERROR` / `INTERNAL` | |
| 502 | `GITHUB_API_ERROR` | Only on explicit GitHub-linking endpoints; never on moves |
| 502 | `SOURCE_FETCH_ERROR` | External source fetch failed upstream after the SSRF guard (details: `{ message }`) |

Defined in the error map but never raised by any REST handler — do not match on them:
- `MISSING_AUTH` / `INVALID_API_KEY` — the auth middleware emits `UNAUTHORIZED` instead (MCP raises them natively).

## Auth

Every `/api/*` request except the exempt routes below is rejected with
`401 { "error": { "code": "UNAUTHORIZED", "message": "Invalid or missing API key" } }`
unless the `Authorization` header carries a valid key:

- Format: `Authorization: Bearer lxk_<43 base62 chars>` (regex `^lxk_[0-9A-Za-z]{43}$`).
- The key is SHA-256-hashed and looked up in `api_keys`; `last_used_at` is
  bumped at most hourly. Keys created without a user (`user_id` NULL — the
  seeded `LXK_API_KEY` and setup-wizard keys) resolve to **admin**; keys bound
  to a user carry that user's `role`.
- **Admin vs member:** a `requireAdmin` gate (403 `FORBIDDEN`) protects project
  create/update/delete, column and swimlane mutations, `PUT field-config`, all
  `/api/settings/api-keys/*`, all `/api/admin/*`, and Forge agent/skill CRUD +
  reset + skill binding. Everything else (reads, task/wiki/board operations,
  Forge task creation) works for any valid key.
- **Exempt routes** (no API key needed):
  - `GET /api/health`
  - `/api/setup/*` (first-run wizard)
  - `POST /api/webhooks/github` — HMAC-SHA-256 signature over the raw body is the auth
  - `/api/forge/daemon/*` and `/api/forge/runtimes/register` — also accept the
    daemon token (`x-forge-token: <LXK_FORGE_DAEMON_TOKEN>` header) in place of a key
- **Cloudflare Access** protects the host at the edge. With `LXK_ACCESS_AUD` set,
  `server/api/access-auth.ts` verifies the `Cf-Access-Jwt-Assertion` against the
  team JWKS (audience must match) — an invalid assertion → 401, and the SSR path
  upserts a user from the verified claims. Without `LXK_ACCESS_AUD`, identity
  headers are trusted as-is (tunnel-authenticated; boot warning logged). Admins
  come from `LXK_ADMIN_EMAILS` env or the `admin_emails` setting. API requests
  are never authenticated by Access.

## Entity Schemas (TypeScript)

```typescript
type ID = string;                 // UUID
type ISODate = string;
type TipTapDoc = { type: "doc"; content: unknown[] };

interface Project {
  id: ID;
  name: string;
  slug: string;
  description: string;
  githubRepo: string | null;      // "owner/name"
  createdAt: ISODate;
  updatedAt: ISODate;
}

interface Column {
  id: ID;
  projectId: ID;
  name: string;
  position: number;
  color: string;                  // hex
  wipLimit: number | null;
  requiredFields: string[];       // subset of ["title","description","assignee"]
  githubState: "open" | "closed" | null;
}

interface Swimlane {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;       // YYYY-MM-DD — milestone deadline (date-only)
  archivedAt: ISODate | null; // null = live; set = archived (cascade-archives its tasks)
  kind: "backlog" | "milestone";  // Backlog = system lane (permanent, no deadline)
}

// Per-project customizable task fields. tasks.priority / tasks.type hold
// option IDs; labels+colors resolve through these lists (see Field Config).
interface FieldOption {
  id: ID;
  label: string;
  color: string;            // hex
  position: number;         // ordering; position 0 = create default
}

interface FieldConfig {
  priorities: FieldOption[];
  types: FieldOption[];
}

interface GithubIssue {
  issueId: string;
  issueNumber: number;
  repo: string;                 // "owner/name"
  syncedState: "open" | "closed" | null;
  url: string;                  // derived: github.com/<repo>/issues/<n>
  outOfSync: boolean;           // derived: syncedState !== column's githubState
}

interface Task {
  id: ID;
  projectId: ID;
  columnId: ID;
  swimlaneId: ID;
  title: string;
  description: TipTapDoc;
  priority: ID;               // priority_options.id — resolves via Board.fieldConfig
  type: ID;                   // type_options.id
  assignees: string[];
  position: string;               // fractional-index key (opaque to clients)
  githubs: GithubIssue[];         // multiple GitHub issues per task
  archivedAt: ISODate | null;     // null = live; set = archived (keeps column/position)
  dueAt: string | null;           // YYYY-MM-DD — optional personal deadline; never later than the lane's
  createdAt: ISODate;
  updatedAt: ISODate;
}

interface WikiPageMeta {          // list/tree views — no content
  id: ID;
  projectId: ID;
  title: string;
  slug: string;
  parentId: ID | null;
  position: number;
  hasChildren: boolean;
  createdAt: ISODate;         // wire quirk: list formatters emit "" here
  updatedAt: ISODate;
}

interface WikiPage extends WikiPageMeta {
  content: TipTapDoc;
  contentText?: string;       // plain-text extraction; present on create/update/search responses
  createdAt: ISODate;
}

interface ApiKey {
  id: ID;
  name: string;
  createdAt: ISODate;
  lastUsedAt: ISODate | null;
}

interface RuntimeModel {
  id: string;        // full "provider/model" id, e.g. "opencode/deepseek-v4-flash"
  provider: string;  // e.g. "opencode", "deepseek", "anthropic"
  name: string;      // human-readable description from the agent's model list
}

interface Runtime {
  id: ID;
  name: string;
  provider: "opencode" | "hermes" | "command-code";
  machineId: ID | null;
  agent: string;           // CLI persona flag (opencode --agent); "" = default
  model: string;           // full "provider/model" id — passed verbatim to --model
  printLogs: boolean;
  logLevel: "" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  extraArgs: string[];
  modelsCatalog: RuntimeModel[];  // live list from lexa-cli; [] = offline/hermes/failure
  agentsCatalog: Array<{ id: string; name: string }>; // reported by lexa-cli
  status: "online" | "offline";
  mcpConnected: boolean;      // daemon-reported /mcp reachability
  lastError: string | null;   // last daemon failure (e.g. revoked key); cleared on live heartbeat/register
  hostname: string;
  lastSeen: ISODate | null;
  createdAt: ISODate;
}

interface Machine {
  id: string;              // "hostname-<unique>" (legacy UUID ids keep working)
  hostname: string;
  clis: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }>;
  lastSeen: ISODate | null;  // null = bound, not listening
  createdAt: ISODate;
}

interface RuntimeEvent {
  id: ID;
  machineId: ID;
  action: "install" | "update" | "remove";
  agentCli: "opencode" | "hermes" | "command-code";
  apiKeyId: ID | null;
  status: "pending" | "claimed" | "completed" | "failed";
  error: string | null;
  createdAt: ISODate;
  claimedAt: ISODate | null;
  finishedAt: ISODate | null;
}

interface ForgeTask {
  id: ID;
  runtimeId: ID | null;
  projectId: ID;
  documentType: "task" | "wiki";
  documentId: string;
  documentTitle: string;   // task title / wiki page title — the UI shows this, never the raw result
  agentId: ID;             // global rule bundle (Settings → Agents)
  agentName: string;
  skillId: ID;             // global operation bundle (Settings → Skills)
  skillName: string;
  extraPrompt: string;
  selection: string;
  docContext: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  error: string | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

interface DocumentSource {
  id: ID;
  projectId: ID;
  documentType: "task" | "wiki";
  documentId: string;
  kind: "wiki" | "external";
  title: string;
  ref: string;          // wiki page slug (wiki) or URL (external)
  createdAt: ISODate;
}

interface TaskLink {
  id: ID;
  projectId: ID;
  fromTaskId: ID;       // "this task"
  toTaskId: ID;         // "that task"
  relation: "subtask_of" | "blocked_by" | "related_to";
  createdAt: ISODate;
}

interface TaskLinkSuggestion {
  id: ID;
  title: string;
  columnName: string;
  type: ID;             // type_options.id
  priority: ID;         // priority_options.id
}

interface Board {                 // GET /board — full snapshot, unpaginated
  project: Project;
  columns: Column[];              // ordered by position
  swimlanes: Swimlane[];          // ordered by position
  fieldConfig: FieldConfig;       // priority + type option lists (labels/colors)
  links: TaskLink[];              // all task links in the project
  tasks: Task[];                  // ALL tasks, ordered by (columnId, position)
}

interface ProjectHealth {
  project: Project;
  taskCount: number;
  columnCount: number;
  urgentCount: number;            // tasks with the project's FIRST priority option (position 0) across all columns
  syncCount: number;              // distinct tasks where any linked issue's syncedState ≠ column's githubState
  health: "ok" | "approaching" | "exceeded";
  wipSegments: Array<{
    state: "ok" | "approaching" | "exceeded" | "empty";
    flex: number;                 // proportional width in the WIP mini bar
  }>;
}

interface Dashboard {             // GET /api/dashboard — full dashboard snapshot
  projects: ProjectHealth[];      // ordered by name
  stats: {
    totalTasks: number;
    activeProjects: number;
    wipExceeded: number;
    outOfSync: number;
  };
  urgentTasks: Array<{            // all urgent tasks across all projects, capped at 50
    id: ID;
    title: string;
    projectName: string;
    projectSlug: string;
    columnName: string;
    priority: ID;               // first priority option id (position 0)
  }>;
  outOfSyncTasks: Array<{         // all out-of-sync tasks across all projects, capped at 50
    id: ID;
    title: string;
    projectName: string;
    projectSlug: string;
    repo: string;
    issueNumber: number;
  }>;
}
```

## Endpoints

### Health & Setup wizard

```
GET    /api/health
→ 200 { ok: true }
  API-key exempt (health probe).

GET    /api/setup/status
→ 200 { configured: boolean, needsAdmin: boolean, hasApiKey: boolean,
        hasProjects: boolean, hasUsers: boolean }
  API-key exempt. configured = setup_complete flag OR (api key + admin emails present).

POST   /api/setup/admin        body { email* }
→ 200 { ok: true } | 403 SETUP_LOCKED
  Appends the email to settings.admin_emails (env LXK_ADMIN_EMAILS is also honored).

POST   /api/setup/api-key
→ 200 { key: "lxk_..." }
  Creates a fresh admin key (user_id NULL → admin). rawKey returned once.

POST   /api/setup/seed
→ 200 { seeded: boolean }
  Loads scripts/seed-dev.sql into an empty DB. seeded=false if the file is
  missing or the DB already has projects.

POST   /api/setup/complete
→ 200 { ok: true } | 403 SETUP_LOCKED
  Sets setup_complete=1.

The mutating setup endpoints fail 403 SETUP_LOCKED once setup_complete=1 or
any project exists — the wizard only runs on first install.
```

### Projects

```
GET    /api/projects
→ 200 { data: Project[], nextCursor }   (nextCursor always null — unpaginated)

POST   /api/projects          (admin)
body { name*, slug?, description?, githubRepo? }
→ 201 Project | 403 FORBIDDEN | 409 SLUG_TAKEN

GET    /api/projects/:slug
→ 200 Project | 404

PATCH  /api/projects/:slug   (admin)
body { name?, description?, githubRepo? }
→ 200 Project | 403 FORBIDDEN | 404

DELETE /api/projects/:slug   (admin)
→ 204 | 403 FORBIDDEN | 404 | 409 SLUG_TAKEN (constraint fallback)   (cascades: columns, swimlanes, tasks, wiki)

GET    /api/dashboard
→ 200 Dashboard     (unpaginated full snapshot — health cards, stats, attention lists)
  Health derivation per project:
  - health: "exceeded" if any column has tasks > wipLimit; "approaching" if urgentCount > 0; else "ok"
  - wipSegments: one segment per column, state = compare count vs wipLimit (empty if count=0)
  - urgentCount: tasks WHERE priority = (first priority option for the project) AND column_id IN (project columns)
  - syncCount: tasks WHERE github.outOfSync = true
  urgentTasks/outOfSyncTasks capped at 50 items each
```

### Project Members

```
GET    /api/projects/:slug/members
→ 200 { data: [{ name, email, role: "admin"|"member" }] }
  Users holding an explicit project role (user_project_roles rows). Global
  admins are filtered out. Membership changes are made via
  /api/admin/users/:id/projects — there are no project-scoped write endpoints.
```

### Columns

```
GET    /api/projects/:slug/columns
→ 200 { data: Column[] }         (ordered by position; not paginated — bounded by nature)

POST   /api/projects/:slug/columns      (admin)
body { name*, position?, color?, wipLimit?, requiredFields?, githubState? }
→ 201 Column | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND
  position omitted → appended to end

PATCH  /api/projects/:slug/columns/:id  (admin)
body { name?, color?, wipLimit?, requiredFields?, githubState?, position? }
→ 200 Column | 403 FORBIDDEN | 404

DELETE /api/projects/:slug/columns/:id  (admin)
→ 204 | 403 FORBIDDEN | 409 HAS_CHILDREN { count }   (must migrate tasks first)
```

### Swimlanes

```
GET    /api/projects/:slug/swimlanes        → 200 { data: Swimlane[] }   (includes archived lanes)
POST   /api/projects/:slug/swimlanes   (admin)  body { name*, description?, position?, dueAt? } → 201 Swimlane | 403 FORBIDDEN
PATCH  /api/projects/:slug/swimlanes/:id  (admin) body { name?, description?, position?, dueAt? } → 200 Swimlane | 403 FORBIDDEN
  dueAt = "YYYY-MM-DD" (date-only milestone deadline); null clears.
  Setting dueAt earlier than any live task's deadline in the lane → 409 DEADLINE_AFTER_LANE { date }
  dueAt on the Backlog lane → 409 BACKLOG_PROTECTED
DELETE /api/projects/:slug/swimlanes/:id  (admin) → 204 | 403 FORBIDDEN (tasks must be reassigned first — swimlane_id is NOT NULL)
  Backlog lane → 409 BACKLOG_PROTECTED

POST   /api/projects/:slug/swimlanes/:id/archive  (admin)
→ 200 { data: Swimlane, activity: ActivityEvent[] } | 403 FORBIDDEN | 404 | 409 BACKLOG_PROTECTED
  One transaction: lane archivedAt set + every live task in the lane archived
  (one `archived` activity row per task). Idempotent.
  Note: archiving tasks does NOT sync GitHub state.

POST   /api/projects/:slug/swimlanes/:id/restore  (admin)
→ 200 { data: Swimlane, activity: ActivityEvent[] } | 403 FORBIDDEN | 404
  Lane only — tasks stay archived (restore individually). Idempotent.
```

### Tasks

```
GET    /api/projects/:slug/tasks?columnId&swimlaneId&assignee&type&limit&cursor
  type = a type_options ID from field-config
→ 200 { data: Task[], nextCursor }
  List rows carry `description` as an empty doc (slim select) — fetch the
  task for content. Board responses behave the same.

POST   /api/projects/:slug/tasks
body { columnId*, swimlaneId?, title*, description?, priority?, type?, parentId?, assignees?, dueAt? }
  priority/type = option IDs from field-config; omitted → first option (position 0)
  swimlaneId omitted → task lands in the project's Backlog lane
  parentId = create as subtask of that task (inherits parent's column/swimlane,
             inserts a subtask_of link)
  dueAt = "YYYY-MM-DD" — must not be later than the lane's due date (when it has one)
→ 201 Task
  | 404 COLUMN_NOT_FOUND / SWIMLANE_NOT_FOUND / TASK_NOT_FOUND (bad parentId)
  | 409 DEADLINE_AFTER_LANE        (dueAt later than lane due)
  | 422 REQUIRED_FIELD            (creating directly into a guarded column)
  | 422 INVALID_OPTION            (bad priority/type id)
  position: appended to end of column

GET    /api/projects/:slug/tasks/:id
→ 200 Task | 404

PATCH  /api/projects/:slug/tasks/:id
body { title?, description?, priority?, type?, assignees?, dueAt? }
→ 200 Task | 404 | 422 REQUIRED_FIELD   (can't clear a required field in guarded column)
  | 422 INVALID_OPTION           (bad priority/type id)
  | 409 DEADLINE_AFTER_LANE      (dueAt later than lane due)
  dueAt change emits a `field_changed` activity event (variant dueAt)

POST   /api/projects/:slug/tasks/:id/move
body { columnId*, swimlaneId*, beforeTaskId?, afterTaskId?, clearDueAt? }
  - swimlaneId required — every task belongs to a swimlane
  - beforeTaskId/afterTaskId omitted → append to end of target column
  - before/after must belong to target column
  - clearDueAt=true → card deadline cleared in the SAME atomic UPDATE as the move
    (required when the card's deadline is later than the target lane's)
→ 200 Task
  | 404 TASK_NOT_FOUND / COLUMN_NOT_FOUND / SWIMLANE_NOT_FOUND
  | 409 WIP_LIMIT
  | 409 DEADLINE_AFTER_LANE      (card dueAt later than target lane due, no clearDueAt)
  | 422 REQUIRED_FIELD / NEIGHBOR_NOT_IN_COLUMN
  (within-column reorder never fails WIP)
  Side effect: if target column has githubState and task is linked,
  best-effort GitHub state sync fires (failure does not fail the request;
  task.github.outOfSync becomes true)

DELETE /api/projects/:slug/tasks/:id
→ 204 | 404 | 409 TASK_HAS_CHILDREN (defensive — subtask links cascade on delete)

POST   /api/projects/:slug/tasks/:id/archive
→ 200 Task (archivedAt set) | 404
  Idempotent: archiving an already-archived task returns it unchanged.
  Archived tasks keep column/swimlane/position; they are excluded from
  board/WIP/count queries unless includeArchived is set.

POST   /api/projects/:slug/tasks/:id/restore
→ 200 Task (archivedAt null) | 404
  Idempotent: restoring a live task returns it unchanged.

GET    /api/projects/:slug/board?includeArchived=true
→ 200 Board          (unpaginated full snapshot — the kanban's single fetch)
  includeArchived omitted/false → archived tasks AND archived lanes excluded; true → both included
  (rendered dimmed in the UI, non-draggable, still in their original column/lane)
  fieldConfig included — tasks' priority/type are option IDs resolved via it
  links included — subtask grouping + blocked dots render without extra fetches
  swimlanes carry dueAt/archivedAt/kind — the Backlog lane (kind=backlog) is the
  permanent system lane; every project has exactly one
```

### Activity & Comments

```
GET    /api/projects/:slug/tasks/:id/activity?cursor&limit
       → 200 { data: ActivityItem[], nextCursor }
       Item = { kind:'event', id, type, actorKind, actorLabel, actorUserId, message, createdAt }
            | { kind:'comment', id, authorKind, authorLabel, authorId, body: TipTapDoc,
                editedAt, createdAt }
       (limit default 50, max 200; ascending; cursor opaque)

POST   /api/projects/:slug/tasks/:id/comments     { body: TipTapDoc }
       → 201 { data: { comment, activity } }      # activity = 'commented' row
       | 404 TASK_NOT_FOUND | 422 COMMENT_INVALID (empty/malformed/>64KB)

PATCH  /api/projects/:slug/tasks/:id/comments/:commentId   { body }
       → 200 { data: Comment }                    # sets edited_at; no activity row (marker only)
       | 404 COMMENT_NOT_FOUND | 403 COMMENT_EDIT_FORBIDDEN | 422 COMMENT_INVALID

DELETE /api/projects/:slug/tasks/:id/comments/:commentId
       → 204                                      # soft delete + 'comment_deleted' row
       | 404 COMMENT_NOT_FOUND | 403 COMMENT_DELETE_FORBIDDEN
```

- Authz: edit = author only; delete = author or project admin (`users.role='admin'`
  or admin `user_project_roles` row).
- Errors: `COMMENT_NOT_FOUND` 404 · `COMMENT_EDIT_FORBIDDEN` 403 ·
  `COMMENT_DELETE_FORBIDDEN` 403 · `COMMENT_INVALID` 422.
- Event types (the `type` field): `created` · `moved` · `field_changed`
  (title/description/priority/type/assignees — no diffs) · `archived` ·
  `restored` · `deleted` · `link_added` · `link_removed` · `source_added` ·
  `source_removed` · `github_linked` · `github_unlinked` · `github_synced`
  (webhook-driven) · `forge_completed` · `forge_failed` · `forge_cancelled` ·
  `commented` · `comment_deleted`.
- Messages frozen at write time (e.g. `"Maria moved from In Progress to Done"`).
  Column renamed later → old messages keep the old name (by design).

**Response envelope rule (invariant #6):** all task mutation responses include
`activity?: ActivityEvent[]` (the rows appended by that mutation) — e.g.
create/update/move/archive/restore return `{ data: Task, activity }`; link/source
adds and GitHub link/unlink likewise. Clients prepend them to the timeline cache
via `setQueryData`; never `invalidateQueries` on the mutation path. Webhook-driven
entries appear on the next slideover open (documented).

### Task Links (subtasks, blocked-by, related)

```
GET    /api/projects/:slug/tasks/:id/links
→ 200 { data: TaskLink[] }        // all relations involving the task

POST   /api/projects/:slug/tasks/:id/links
body { toTaskId*, relation*: "subtask_of"|"blocked_by"|"related_to" }
→ 201 TaskLink
  | 404 TASK_NOT_FOUND
  | 409 TASK_LINK_CYCLE            // subtask_of would create a cycle
  | 422 INVALID_TASK_LINK          // self-link, cross-project

DELETE /api/projects/:slug/tasks/:id/links/:linkId
→ 204 | 404 TASK_LINK_NOT_FOUND

GET    /api/projects/:slug/tasks/search?q&exclude
→ 200 { data: TaskLinkSuggestion[] }   // @-autocomplete; title LIKE, cap 10
  exclude = task id to skip (the current task)
```

Notes:
- `subtask_of`: child inherits the parent's column; moving a parent cascades to
  children (same column, re-keyed after parent, WIP-bypassed).
- `blocked_by`: informational — warning dot on the card, listed in detail. No
  move guard.
- `related_to`: symmetric display, stored once (from→to).

### Field Config (priorities & types)

```
GET    /api/projects/:slug/field-config
→ 200 FieldConfig        (priorities + types, each ordered by position)

PUT    /api/projects/:slug/field-config  (admin)
body { priorities: FieldOption[], types: FieldOption[] }   (FULL REPLACE of both lists)
  Each option: { id?, label*, color*, position* }
    - id omitted → create; id present → update that option
    - options missing from the payload are deleted (only if unused by tasks)
→ 200 FieldConfig
  | 403 FORBIDDEN
  | 404 PROJECT_NOT_FOUND
  | 409 OPTION_IN_USE { optionId, label }     (delete blocked: tasks reference it)
  | 422 INVALID_OPTION { optionId }           (unknown id, or label duplicates, or empty list)
```

Notes:
- `position` is authored by the client (drag-reorder); the server stores it as given.
- The **first** option (position 0) in each list is the create default and the
  dashboard "urgent" equivalent for that project.
- Deleting a used option is rejected — reassign or delete tasks first.
- `PATCH /projects/:slug/tasks/:id` and `POST /projects/:slug/tasks` accept
  priority/type as option IDs; unknown or foreign-project IDs → `INVALID_OPTION`.

### Task ↔ GitHub link

```
POST   /api/projects/:slug/tasks/:id/github-link
body { repo* }                   ("owner/name" — creates a GitHub issue from the task)
→ 200 Task (with github populated) | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  ALREADY_LINKED fires when the task already has an issue in the same repo
  (multi-issue: one link per repo per task).

DELETE /api/projects/:slug/tasks/:id/github-link/:issueId
→ 200 Task | 404 TASK_NOT_FOUND
  Unlinks the specific issue (issueId = GitHub node_id). Does NOT close or
  delete the GitHub issue. Idempotent: unknown issueId is a no-op.
```

### Wiki

```
GET    /api/projects/:slug/wiki
→ 200 { data: WikiPageMeta[] }   (ALL pages of the project, flat — no
  parentId filter, no pagination; parentId + hasChildren let the client tree
  the list)

POST   /api/projects/:slug/wiki
body { title*, slug?, content?, parentId? }
→ 201 WikiPage | 404 PROJECT_NOT_FOUND | 409 SLUG_TAKEN

GET    /api/projects/:slug/wiki/:pageSlug
→ 200 WikiPage | 404 PAGE_NOT_FOUND

PATCH  /api/projects/:slug/wiki/:pageSlug
body { title?, slug?, content?, parentId?, position?, saveType?: "autosave"|"manual" }
  saveType defaults to "autosave" — controls which revision bucket the update
  lands in.
→ 200 WikiPage | 404 | 409 CONSTRAINT

DELETE /api/projects/:slug/wiki/:pageSlug
→ 204 | 404 | 409 HAS_CHILDREN { count }

GET    /api/projects/:slug/wiki/:pageSlug/children
→ 200 { data: WikiPageMeta[] }     (ordered by position)

GET    /api/projects/:slug/wiki/search?q*
→ 200 { data: Array<WikiPage & { snippet }> }
  snippet: FTS5 match context (~160 chars, <mark> tags around hits).
  q missing/empty → 200 { data: [] }.

GET    /api/projects/:slug/wiki/:pageSlug/revisions?limit
→ 200 { revisions: [{ id, title, saveType: "autosave"|"manual", createdAt }] }
  Newest first. limit clamped 1–200.

GET    /api/projects/:slug/wiki/:pageSlug/revisions/:revisionId
→ 200 { revision: { id, pageId, title, slug, content: TipTapDoc,
                    contentText: string, saveType, createdAt } }
  | 404 PAGE_NOT_FOUND   (also when the revision belongs to a different page)

POST   /api/projects/:slug/wiki/:pageSlug/restore
body { revisionId* }
→ 200 WikiPage  | 404 PAGE_NOT_FOUND (unknown page or revision)
  Rolls the page back to that revision (records a new revision).
```

### Settings

```
GET    /api/settings/api-keys  (admin)
→ 200 { data: ApiKey[] }

POST   /api/settings/api-keys  (admin)
body { name* }
→ 201 { key: ApiKey, rawKey: "lxk_..." }
  ⚠ rawKey returned ONCE — never stored, never shown again

DELETE /api/settings/api-keys/:id  (admin)
→ 204 | 404
```

### Admin (users & project roles)

All endpoints require an admin caller — members get `403 FORBIDDEN`.

```
GET    /api/admin/users
→ 200 { data: [{ id, email, name, role, createdAt, lastSeen }] }

PATCH  /api/admin/users/:id       body { role*: "admin"|"member" }
→ 200 { id, email, name, role, createdAt, lastSeen }
  | 403 FORBIDDEN | 404 USER_NOT_FOUND | 403 CANNOT_DELETE_SELF
  (demote-to-member on self → `CANNOT_DELETE_SELF`; the caller identity comes
  from the API key, not a placeholder)

GET    /api/admin/users/:id/projects
→ 200 { data: [{ projectId, projectSlug, role: "admin"|"member" }] }

PUT    /api/admin/users/:id/projects    body { projectId*, role*: "admin"|"member" }
→ 200 { projectId, projectSlug, role }
  | 403 FORBIDDEN
  (wire quirk: projectSlug currently echoes projectId)

DELETE /api/admin/users/:id/projects/:projectId
→ 204 | 403 FORBIDDEN
```

### Me (self-service profile)

The acting browser user, named by the `x-lxk-user` header (the key still
authorizes). Bare API keys without `x-lxk-user` get `400 NO_USER_CONTEXT` —
agents have no profile to edit.

```
PATCH  /api/me      body { name*: string (trimmed, 1-80 chars) }
→ 200 { id, email, name, role, createdAt, lastSeen }
  | 400 NO_USER_CONTEXT | 404 USER_NOT_FOUND | 422 INVALID_NAME
```

The browser-facing identity (`<meta name="lxk-user">`) carries
`{ email, name, role, createdAt, lastSeen }`; the "Sign out" meta
(`<meta name="lxk-logout">`) is only emitted when `LXK_ACCESS_TEAM` is set,
and the UI hides Sign out otherwise.

### GitHub Webhook

```
POST   /api/webhooks/github
headers: X-GitHub-Event: issues, X-GitHub-Delivery, X-Hub-Signature-256
→ 200 immediately (processing deferred to the background — Bun has no
  waitUntil; the handler acks first, then processes fire-and-forget)
→ 401 { error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" } }
  on signature mismatch (before body parsing)
Handled: event "issues" with payload.action closed | reopened | edited
  (GitHub sends the transition in the payload, not in the header)
```

### Forge (AI writing assistant)

```
POST   /api/forge/runtimes/register        (daemon child; x-forge-token or Bearer)
body { id?, name*, provider*: "opencode"|"hermes"|"command-code", machineId*, model?, hostname? }
→ 201 Runtime

PATCH  /api/forge/runtimes/:id              (browser)
body { name?, provider?, agent?, model?, printLogs?, logLevel?, extraArgs?: string[] }   (server-authoritative config)
→ 200 Runtime
  | 404 RUNTIME_NOT_FOUND
Edits apply to the daemon's next claim — no restart needed. provider switches
which CLI the daemon spawns (the daemon machine must have it installed);
agent is the CLI's internal persona flag (opencode --agent build/plan; empty =
default) — labelled "Persona" in the UI to distinguish it from Lexa's own
agents (rule bundles). extraArgs are appended verbatim to the agent CLI spawn
(no shell). model stores the full "provider/model" id (e.g. "opencode/deepseek-v4-flash") —
passed verbatim
to --model. hostname/status are daemon-reported and not editable.

GET    /api/forge/runtimes
→ 200 { data: Runtime[] }                  (offline if last_seen > 2 min ago)

DELETE /api/forge/runtimes/:id              (browser)
→ 204 | 404 RUNTIME_NOT_FOUND
Removal never blocks: it queues a machine-scoped `remove` event (delivered
whenever the machine's listener next heartbeats — the listener kills the
matching child + env directory) and deletes the runtime row. A machine hosts
at most one runtime per agent CLI, so the whole (machine, provider) pair is
removed — keeping host state consistent with the provider-scoped event.
Runtimes without a machine are deleted directly.

POST   /api/forge/daemon/heartbeat         (daemon child)
body { runtimeId*, mcpConnected? }
→ 200 { ok: true }
The daemon reports liveness and MCP status. `lexa-cli machine listen` discovers
agent/model catalogs and sends them through the machine heartbeat. A live
heartbeat clears the runtime's last_error. A revoked runtime key makes every
daemon call return 401 — the daemon exits with code 3 and the listener does
NOT respawn it; the listener relays the failure on its next machine heartbeat
(daemonErrors) so the runtime row shows last_error = "API key revoked".
Recovery: re-run Setup runtime (install event delivers a fresh key).

POST   /api/forge/daemon/claim             (daemon)
body { runtimeId* }
→ 200 { task: ForgeTask | null, provider, agent, model: string, printLogs: boolean,
        logLevel: ""|"DEBUG"|"INFO"|"WARN"|"ERROR", extraArgs: string[], prompt: string,
        agentMarkdown: string, skillMarkdown: string, skillIds: string[] }
        skillIds = full current skill-id set; the daemon prunes stale
        .agents/skills/<id> dirs not in this list (opencode auto-discovers
        every bundle in that dir)
  (oldest queued, FIFO; marks running. provider + agent + model + printLogs +
  logLevel + extraArgs are the runtime's server-side config so the daemon
  spawns the configured CLI with the latest settings. prompt is the
  server-built task prompt (context + output contract; empty = the daemon
  falls back to its local minimal build).
  agentMarkdown/skillMarkdown are the task's agent + skill instructions — the
  daemon writes them into the run dir as AGENTS.md + .agents/<skill>/SKILL.md
  (files-only delivery, no host store).)

# ── Runtime setup events (web wizard → machine CLI listener) ──
POST   /api/forge/runtime-events           (browser)
body { machineId*, action*: "install"|"update", agentCli*, apiKeyId?, rawKey? }
→ 201 RuntimeEvent
  | 404 MACHINE_NOT_FOUND / API_KEY_NOT_FOUND
The wizard sends only machine + agent CLI. Provider/model, agent persona,
logging, and extra args are configured after setup. Install creates a FRESH API
key; rawKey is verified against the stored SHA-256 hash and held ONLY in memory.

POST   /api/forge/runtime-events/claim     (listener; Bearer + x-machine-secret)
body { machineId* }   header: x-machine-secret
→ 200 { event: RuntimeEvent | null, rawKey: string | null }   (null = none pending)
  | 403 FORBIDDEN ("machine secret mismatch" — identical for missing machine,
    legacy '' secret, missing header, wrong secret; no existence oracle)
Oldest pending event for that machine, marked claimed. rawKey is delivered ONCE
here (removed from the in-memory store); null if the claim TTL (5 min) expired.
A claimed event is reclaimed after 2 min if never completed.
The secret binds machine identity: it is minted once at register, returned a
single time, and required on every claim — a key holder without the machine's
secret cannot hijack another machine's pending install event.

POST   /api/forge/runtime-events/:id/complete   (listener)  → 200 RuntimeEvent
POST   /api/forge/runtime-events/:id/fail       (listener)  body { error* } → 200 RuntimeEvent
  (complete/fail only transition from 'claimed')

GET    /api/forge/runtime-events/:id       (browser)  → 200 RuntimeEvent
GET    /api/forge/runtime-events           (browser)  → 200 { data: RuntimeEvent[] }
  ?machineId=<id> filters by machine

# ── Machine registry and CLI catalogs ──
POST   /api/forge/machines/register             (cli login)
body { id*, hostname*, secret? }
→ 200 { machine, secret: string | null }
  | 409 MACHINE_ID_TAKEN { id, reason: "hostname" | "legacy" | "secret_mismatch" }
Binds a machine: registers WITHOUT touching last_seen — a logged-in machine is
"bound, not listening" (last_seen stays NULL until its listener heartbeats).
Unknown id → minted a fresh 43-char secret, returned EXACTLY ONCE. Known id +
hostname + secret match → idempotent no-op, secret never re-returned. Known id
with mismatched/wrong secret or a legacy '' secret → 409 (remove the machine
and re-register). Machine ids are `hostname-<unique>` (new machines; legacy
UUID ids keep working). The listener persists the secret at
`~/.lexa/machine-secret` (chmod 600).

POST   /api/forge/machines/heartbeat          (listener)
body { id*, hostname?, clis?: [{ provider, version }],
       runtimes?: [{ runtimeId, agentCli, models, agents }],
       daemonErrors?: [{ runtimeId, error }] }
→ 200 Machine & { projects: [{ id, name, slug, description }] }
  projects = full project index; the listener provisions one workspace dir
  per project under ~/.lexa/projects/ and keeps its local lookup fresh.
Upserts a machine row (marks it listening). The CLI persists id in
~/.lexa/machine-id. clis = installed agent CLIs probed at listener start
(opencode/cmd --version; hermes skipped). daemonErrors relay daemon failures
the daemon itself can't report (revoked key → exit code 3) — stored on the
matching runtime row as last_error. Also runs the stuck-task sweep: 'running'
forge tasks whose runtime has been offline > 10 min are re-queued, and stale
'running' runs (started > FORGE_STALE_RUN_MIN, default 30m, runtime offline
or gone) are hard-deleted — task + log — since the runner is dead and will
never post a result.
Catalogs are stored on matching runtime rows and power Settings pickers.

GET    /api/forge/machines                     (browser)
→ 200 { data: Machine[] }
Machines with last_seen > 2 min ago are marked offline. Offline machines stay
visible but cannot be targeted for runtime setup.

DELETE /api/forge/machines/:id                  (browser)
→ 204 | 404 MACHINE_NOT_FOUND
Removes the host: queues machine-scoped `remove` events for each of its
runtimes (deduped per provider, delivered on the listener's next heartbeat),
deletes the runtime rows, its pending setup events (FK cascade), and the
machine row. Never blocks — a still-listening machine reappears on its next
heartbeat (upsert) until `lexa-cli machine stop` is run on it.

POST   /api/forge/tasks                    (browser)
body { slug*, documentType*: "task"|"wiki", documentId*, agentId*, skillId*,
       extraPrompt?, selection?, runtimeId? }
  agentId/skillId reference the global rule bundles (Settings → Agents/Skills);
  extraPrompt is a per-run free-text addition to the prompt.
→ 201 ForgeTask
  | 404 PROJECT_NOT_FOUND / TASK_NOT_FOUND / PAGE_NOT_FOUND / AGENT_NOT_FOUND / SKILL_NOT_FOUND
  | 409 NO_RUNTIME_ONLINE                 (no daemon is up)

GET    /api/forge/tasks/:id
→ 200 ForgeTask

GET    /api/forge/tasks?slug*&documentType&documentId
→ 200 { data: ForgeTask[] }   (for one document, per doc — the Forge panel's
  per-document run list; status newest-first)
  | 404 PROJECT_NOT_FOUND  (slug missing or unknown)

GET    /api/forge/tasks/recent
→ 200 { data: Array<ForgeTask & { projectName }> }   (10 newest, cross-project)

GET    /api/forge/daemon/tasks/:id/status    (daemon)
→ 200 { status: "queued"|"running"|"completed"|"failed"|"cancelled" }
  Polling fallback for daemons that cannot stream logs.

POST   /api/forge/tasks/:id/cancel             (browser)
→ 200 ForgeTask  (status → "cancelled"; daemon discards the run)

GET    /api/forge/tasks/:id/logs               (browser)
→ 200 { data: ForgeTaskLog[] }   (ascending; live activity feed while running)
Each log row carries stream ("out"|"err") + level ("info"|"warn"|"error") —
classified ONCE by the daemon at write time (shared/forge-log.ts) and stored;
the UI renders the stored level. Legacy rows default to out/info.

GET    /api/forge/tasks/history                (browser)
query { slug?, status?, skillId?, documentType?, limit?, cursor? }
  status: queued | running | completed | failed | cancelled
  skillId: a skill's id (filter by operation bundle)
  limit: 1–200 (default 50) · cursor: opaque keyset cursor
→ 200 {
  data: Array<ForgeTask & { projectName }>,
  nextCursor: string | null,
  summary: { queued, running, completed, failed, cancelled }   (global, not filter-scoped)
}
Cross-project task history for the Forge control panel, newest first.
Keyset-paginated on (created_at, id) DESC; nextCursor is null on the last
page. summary carries per-status totals and is NOT scoped by the filters —
the strip describes the system, the table is the view. The frontend polls
this endpoint every 1.5s while any row on the page is queued/running, else
on a 15s idle heartbeat.

# ── Forge agents & skills (global rule bundles; browser, Bearer) ──
# All mutations are admin-only (403 FORBIDDEN for members).
GET    /api/forge/agents
→ 200 { data: ForgeAgent[] }   (agent = { id, name, description, instructions,
  isBuiltin, skillIds[], createdAt, updatedAt })

POST   /api/forge/agents        (admin)  body { name*, description?, instructions* }
→ 201 ForgeAgent  | 403 FORBIDDEN | 409 CONSTRAINT (duplicate name)

PATCH  /api/forge/agents/:id    (admin)  body { name?, description?, instructions? }
→ 200 ForgeAgent  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 409 CONSTRAINT

DELETE /api/forge/agents/:id    (admin)
→ 204 | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 422 FORGE_BUILTIN_DELETE | 409 FORGE_ENTITY_IN_USE
  (builtins can't be deleted; an agent still used by forge tasks can't either)

PUT    /api/forge/agents/:id/skills  (admin)  body { skillIds*: string[] }  (full replace)
→ 200 ForgeAgent  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND / SKILL_NOT_FOUND
  (M2M bindings; the Forge popover only offers the attached skills)

POST   /api/forge/agents/:id/reset  (admin; builtin only)
→ 200 ForgeAgent  (restores the seeded instructions + full builtin skill set)
  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 422 FORGE_BUILTIN_DELETE

GET    /api/forge/skills
→ 200 { data: ForgeSkill[] }   (skill = { id, name, description, instructions, isBuiltin, createdAt, updatedAt })

POST   /api/forge/skills        (admin)  body { name*, description?, instructions* }
→ 201 ForgeSkill  | 403 FORBIDDEN | 409 CONSTRAINT

PATCH  /api/forge/skills/:id    (admin)  body { name?, description?, instructions? }
→ 200 ForgeSkill  | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 409 CONSTRAINT

DELETE /api/forge/skills/:id    (admin)
→ 204 | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 422 FORGE_BUILTIN_DELETE | 409 FORGE_ENTITY_IN_USE

POST   /api/forge/skills/:id/reset  (admin; builtin only)
→ 200 ForgeSkill  | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 422 FORGE_BUILTIN_DELETE

POST   /api/forge/daemon/tasks/:id/log         (daemon)  body { message*, stream? ("out"|"err"), level? ("info"|"warn"|"error") } → 200 ForgeTaskLog
(appends one activity line — claim, model, agent start, generating, done/failed;
stream/level are classified once by the daemon and stored; defaults out/info
keep older daemons working)

POST   /api/forge/daemon/tasks/:id/complete   (daemon)  body { result* } → 200 ForgeTask
POST   /api/forge/daemon/tasks/:id/fail       (daemon)  body { error* }  → 200 ForgeTask

GET    /api/projects/:slug/documents/:type/:id/sources
→ 200 { data: DocumentSource[] }

POST   /api/projects/:slug/documents/:type/:id/sources
body { kind*: "wiki"|"external", ref* }   (wiki = page slug; external = URL)
→ 201 DocumentSource
  | 404 PAGE_NOT_FOUND                     (wiki slug unknown)
  | 422 SOURCE_FETCH_ERROR                 (bad URL / private-IP block)

DELETE /api/projects/:slug/documents/:type/:id/sources/:sourceId
→ 204 | 404 SOURCE_NOT_FOUND
```

Notes:
- **Daemon auth:** `/api/forge/daemon/*` and `/api/forge/runtimes/register` accept
  the shared secret `LXK_FORGE_DAEMON_TOKEN` via `x-forge-token`, or a normal
  Bearer API key; the other runtime routes require the Bearer key. Browser
  endpoints use the Bearer key. The CLI listener (`machine listen`) uses the
  Bearer key from its saved login for `/api/forge/runtime-events/*` and
  `/api/forge/machines/*`.
- **SSRF guard:** external sources resolve DNS and reject private/loopback/
  link-local/CGNAT addresses before fetching.
- **MCP loop:** the spawned agent CLI receives a server-built prompt; the
  one-shot result is returned to the editor for accept/reject.

## Notes

- **Mutation responses are authoritative.** Every mutating endpoint returns the updated entity. The frontend updates TanStack Query cache from the response (`setQueryData`) and never refetches on the mutation path — the response is the authoritative state.
- **`position` is opaque.** Clients never read or write it directly; ordering is expressed via `beforeTaskId`/`afterTaskId` (tasks) or `position` integer reassignment (columns/swimlanes/wiki siblings).
- **`:slug` in task routes is routing context**, not an authorization boundary in v1 (single-tenant, Access-gated). Task IDs are globally unique UUIDs.
