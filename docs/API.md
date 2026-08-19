# REST API Contract (v1)

> Derived from ARCHITECTURE.md (v2.1) routes and LAYERS.md (v2.1) services. This is the frontend↔backend contract.

## Conventions

| Concern | Convention |
|---------|-----------|
| Base URL | `https://<host>/api` (Bun server behind the cloudflared tunnel) |
| Auth | Dual-channel: `Authorization: Bearer lxk_<43 base62 chars>` (machines — required by every `/api/*` route except the exempt list below, see Auth) OR a Better Auth session cookie (humans — browsers). `/api/auth/*` is mounted BEFORE the key middleware. The `x-lxk-user` header is removed. |
| Content type | `application/json; charset=utf-8` |
| IDs | UUID strings; users, teams (organizations), sessions and related Better Auth rows use Better Auth ids (32-char, `[a-zA-Z0-9]`; migrated legacy rows are 32 lowercase hex — opaque, do not pattern-match) |
| Timestamps | ISO 8601 UTC (`2026-07-27T10:30:00Z`) |
| Rich text | **TipTap/ProseMirror JSON object** on REST. |
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
| 401 | `UNAUTHORIZED` | Missing or invalid API key or session cookie (auth middleware in `server/api/middleware.ts`; see Auth) |
| 401 | `GITHUB_WEBHOOK_ERROR` | Webhook signature mismatch (before body parsing) |
| 403 | `FORBIDDEN` | Superadmin- or team-admin-gated endpoint called without authority, project access denied (details: `{ message }`), or machine-secret mismatch on runtime-event claim |
| 403 | `SETUP_LOCKED` | Mutating `/api/setup/*` call after setup is complete or projects exist |
| 403 | `SOLE_OWNER` | Demoting or removing the last owner of a team (details: `{ message }` — transfer ownership first) |
| 403 | `CANNOT_DELETE_SELF` | Removing the last superadmin / self-removal via the workspace member routes (details: `{ message }`) |
| 404 | `USER_NOT_FOUND` | Unknown user id on admin/workspace/team-member endpoints |
| 404 | `TEAM_NOT_FOUND` `INVITE_NOT_FOUND` `SESSION_NOT_FOUND` | Unknown team / invite / own-session id |
| 404 | `PROJECT_NOT_FOUND` `COLUMN_NOT_FOUND` `SWIMLANE_NOT_FOUND` `MILESTONE_NOT_FOUND` `TASK_NOT_FOUND` `PAGE_NOT_FOUND` `SOURCE_NOT_FOUND` `FORGE_TASK_NOT_FOUND` `TASK_LINK_NOT_FOUND` `MACHINE_NOT_FOUND` `RUNTIME_NOT_FOUND` `RUNTIME_EVENT_NOT_FOUND` `API_KEY_NOT_FOUND` `AGENT_NOT_FOUND` `SKILL_NOT_FOUND` | |
| 409 | `SLUG_TAKEN` | Duplicate project slug, wiki slug, or team slug (details: `{ slug }`); also the constraint fallback on project update/delete |
| 409 | `INVITE_PENDING` | An invite is already pending for that email (details: `{ email }`) |
| 409 | `MACHINE_ID_TAKEN` | Machine id already registered to another host, legacy (no secret), or secret mismatch (details: `{ id, reason: "hostname" \| "legacy" \| "secret_mismatch" }`) |
| 409 | `TASK_HAS_CHILDREN` | Task delete hits a constraint (defensive — subtask links cascade on delete) |
| 409 | `NO_RUNTIME_ONLINE` | Create Forge task with no daemon online |
| 409 | `TASK_LINK_CYCLE` | subtask_of link would create a cycle (details: `{ message }`) |
| 409 | `HAS_CHILDREN` | Delete column with tasks / wiki page with children / milestone with sprints (details: `{ count }`) |
| 409 | `WIP_LIMIT` | Move would exceed column WIP limit |
| 409 | `BACKLOG_PROTECTED` | Archive/delete or deadline changes on the system Backlog lane (details: `{ action }`) |
| 409 | `DEADLINE_AFTER_LANE` | Task deadline later than its lane's due date (details: `{ date }`) |
| 409 | `ALREADY_LINKED` | Task already has a GitHub issue in that repo |
| 409 | `OPTION_IN_USE` | Delete priority/type option still referenced by tasks (details: `{ optionId, label }`) |
| 409 | `FORGE_ENTITY_IN_USE` | Delete agent/skill still used by forge tasks (details: `{ kind, name, count }`) |
| 409 | `TEAM_HAS_PROJECTS` | Delete team while it owns projects (details: `{ count }` — reassign projects first) |
| 409 | `CONSTRAINT` | Generic constraint-violation fallback (typed codes like `SLUG_TAKEN` / `HAS_CHILDREN` / `OPTION_IN_USE` are raised whenever possible) |
| 413 | `BODY_TOO_LARGE` | Request body exceeds `LXK_MAX_BODY_MB` (default 16) — early gates, before auth: stream cap in `server/entry.ts` (chunked/CL-less bodies included) + declared-length pre-check in the API middleware |
| 422 | `REQUIRED_FIELD` | Column's `required_fields` not satisfied (details: `{ field, column }`) |
| 422 | `NEIGHBOR_NOT_IN_COLUMN` | `beforeTaskId`/`afterTaskId` not in target column (details: `{ taskId }`) |
| 422 | `INVALID_OPTION` | Unknown priority/type option id, duplicate label, or empty option list (details: `{ optionId? }`) |
| 422 | `INVALID_TASK_LINK` | Self-link or cross-project task link (details: `{ message }`) |
| 422 | `FORGE_BUILTIN_DELETE` | Delete/reset of a builtin agent or skill (details: `{ kind, name }`) |
| 422 | `SEARCH_ERROR` | Wiki FTS5 query rejected |
| 422 | `SOURCE_UNREACHABLE` | External source DNS/fetch failed after the SSRF guard (details: `{ url }`) |
| 422 | `API_KEY_NAME_EMPTY` | API key name missing or blank |
| 422 | `NOT_WORKSPACE_MEMBER` | Team-member add targets an email that is not a workspace member (details: `{ email, available }` — invite via the superadmin first) |
| 422 | `INVALID_ARGS` | Sprint start date later than its due date (details: `{ reason }`) |
| 429 | `RATE_LIMITED` | Per-IP rate limit exceeded on `/api/*` (webhook, `/api/forge/daemon/*`, `/api/forge/runtimes/register` exempt; `/api/setup*` + `/api/health` ARE limited) — enforced in the API middleware, one shared bucket |
| 500 | `DATABASE_ERROR` / `INTERNAL` | |
| 500 | `PASSWORD_LINK_FAILED` | Admin-issued set-password link could not be issued (details: `{ message }`) |
| 502 | `GITHUB_API_ERROR` | Only on explicit GitHub-linking endpoints; never on moves |
| 502 | `SOURCE_FETCH_ERROR` | External source fetch failed upstream after the SSRF guard (details: `{ message }`) |

Defined in the error map but never raised by any REST handler — do not match on them:
- `MISSING_AUTH` / `INVALID_API_KEY` — the auth middleware emits `UNAUTHORIZED` instead.
- `LAST_ADMIN_DEMOTE` — legacy user-role editing is removed (superadmin is env-only; user lifecycle goes through `/api/workspace/members`).

## Auth

Every `/api/*` request except the exempt routes below is rejected with
`401 { "error": { "code": "UNAUTHORIZED", "message": "Invalid or missing API key" } }`
unless it authenticates via one of two channels:

- **Session cookie (humans):** browser pages and `/api/*` calls carry the
  Better Auth session cookie (mounted at `/api/auth/*`, `tanstackStartCookies`).
  Identity = the session user (id, name, email, role).
- **Bearer API key (machines):** `Authorization: Bearer lxk_<43 base62 chars>`
  (regex `^lxk_[0-9A-Za-z]{43}$`). The key is SHA-256-hashed and looked up in
  `api_keys`; `last_used_at` is bumped at most hourly. Keys created without a
  user (`user_id` NULL — the seeded `LXK_API_KEY` and setup-wizard keys)
  resolve to **admin**; keys bound to a user carry that user's role. Key auth
  for CLI/webhooks is unchanged.

**Attribution (R5):** the actor is the session user for browser calls and the
key name for machine calls. The `x-lxk-user` header is **removed** — never
sent by browsers, never read by the server. The `<meta name="lxk-api-key">`
injection and `VITE_LXK_API_KEY` are still live — the server injects its
current `LXK_API_KEY` into the served HTML (meta) and the client prefers it
over the build-time baked key; browser `/api/*` calls otherwise authenticate
via the session cookie.

- **Superadmin vs member:** `users.role` ∈ {superadmin, member} — superadmin is
  env-only (`LXK_ADMIN_EMAILS`, applied at provisioning via the setup wizard),
  never edited at runtime (no role-editing endpoint; legacy `admin` → `superadmin`).
  A `requireSuperadmin` gate (403 `FORBIDDEN`) protects project
  create/update/delete, column and swimlane mutations, `PUT field-config`, all
  `/api/settings/*`, all `/api/admin/*`, Forge agent/skill CRUD + reset + skill
  binding, and the teams/workspace lifecycle endpoints (see Teams & Workspace).
  Team-admin authority comes from the org `member.role` (owner/admin) on the
  team, never from `users.role`.
- **Exempt routes** (no API key needed):
  - `/api/auth/*` — Better Auth handler, mounted BEFORE the key middleware.
    Keyless by design; throttled per-IP (120/min) with the same body cap as
    `/api/*`. `LXK_PUBLIC_URL` must be set to the app's public origin —
    it drives cookie security, `trustedOrigins` (CSRF origin checks), and the
    invite/set-password link base. In dev (`LXK_ENV=dev`) `http://localhost:5173`
    is trusted as well (vite proxies `/api`, cookie-bearing auth POSTs carry
    its Origin).
  - `GET /api/health`
  - `/api/setup/*` (first-run wizard)
  - `POST /api/webhooks/github` — HMAC-SHA-256 signature over the raw body is the auth
  - `/api/forge/daemon/*`, `/api/forge/runtimes/register`, and
    `/api/forge/sessions` — also accept the
    daemon token (`x-forge-token: <LXK_FORGE_DAEMON_TOKEN>` header) in place of a key
    (`/api/forge/sessions` joins the daemon's PUT/DELETE and the browser's
    GET/reset)
- **Login rate limit (R17):** failed logins on `/api/auth/sign-in/email` are
  throttled by an in-process limiter (5 attempts/60s per email, 15 min
  lockout; success resets — better-auth 1.6.27 has NO rate-limit plugin, so
  this ships instead). The whole keyless `/api/auth/*` surface additionally
  gets a per-IP throttle (120 req/min) and the same body cap as `/api/*`.
  Residual risk: the per-email budget lets an attacker lock out a known email
  with 5 tries (same as any login form); the per-IP throttle bounds the blast
  radius per source.

## Entity Schemas (TypeScript)

```typescript
type ID = string;                 // UUID
type ISODate = string;
type TipTapDoc = { type: "doc"; content: unknown[] };

interface ProjectRepo {
  repo: string;                   // "owner/name"
  sourceRole: boolean;            // Forge context + project label
  workspaceRole: boolean;         // issue link/create/sync
}

interface Project {
  id: ID;
  name: string;
  slug: string;
  description: string;
  teamId: ID | null;          // owning team (organization id); null = unassigned, superadmin-only until assigned
  repos: ProjectRepo[];           // linked repos with roles (replaces githubRepo)
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ── Auth, teams & sessions ──

interface LexaUser {
  id: ID;                     // Better Auth id (32-char, [a-zA-Z0-9])
  email: string;
  name: string;
  role: "superadmin" | "member";   // env-only superadmin — never edited at runtime
  createdAt: ISODate;
  lastSeen: ISODate | null;
}

interface Team {              // = Better Auth organization; slug unique
  id: ID;
  name: string;
  slug: string;
  createdAt: string;
}

type TeamMemberRole = "owner" | "admin" | "member";   // org role — the team-admin axis

interface TeamMember {
  userId: ID;
  name: string;
  email: string;
  role: TeamMemberRole;
  createdAt: string;
}

interface WorkspaceInvite {   // superadmin-issued app-member invite (link-based)
  id: ID;
  email: string;
  tokenHint: string;          // short prefix of the link secret (display only)
  expiresAt: string;          // 7d after issue
  acceptedAt: string | null;
}

interface SessionInfo {
  id: ID;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
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
  isDone: boolean;                // done marker — independent of githubState mapping; multiple done columns allowed
}

interface Swimlane {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;       // YYYY-MM-DD — sprint deadline (date-only)
  archivedAt: ISODate | null; // null = live; set = archived (cascade-archives its tasks)
  startAt: string | null;     // YYYY-MM-DD — sprint start (date-only); null = unset
  kind: "backlog" | "sprint"; // Backlog = system lane (permanent, no deadline); sprint = time-boxed lane
  milestoneId: string | null; // owning milestone id; null = loose sprint (not in any milestone)
}

// Goal wrapper above sprints (e.g. "v1.0 launch"). A milestone holds one or
// more sprints; deleting a milestone loosens its sprints (they become
// milestoneId = null, ON DELETE SET NULL). sprintCount includes archived.
interface Milestone {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;           // YYYY-MM-DD target date; null = no deadline
  archivedAt: string | null;      // null = live; set = archived (cascades to its sprints)
  sprintCount: number;            // total sprints (incl. archived) in this milestone
  archivedSprintCount: number;    // archived sprints
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
  outOfSync: boolean;           // derived: syncedState !== column's githubState (state divergence)
  pushFailed: boolean;          // last Lexa→GitHub content push failed (content divergence)
}
// Divergence text on a linked row = outOfSync ("out of sync — state") +
// pushFailed ("— edit not pushed"); both → "— both".

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
  teamId: ID | null;           // owning team; null = global runtime (superadmin-owned, claims any team's tasks)
  agent: string;           // CLI persona flag (opencode --agent); "" = default
  model: string;           // full "provider/model" id — passed verbatim to --model
  printLogs: boolean;
  logLevel: "" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  extraArgs: string[];
  modelsCatalog: RuntimeModel[];  // live list from lexa-cli; [] = offline/hermes/failure
  agentsCatalog: Array<{ id: string; name: string }>; // reported by lexa-cli
  status: "online" | "offline";
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
  milestones: Milestone[];        // ordered by position (incl. archived when includeArchived=true)
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

POST   /api/setup/admin        body { email*, password* }
→ 200 { ok: true } | 403 SETUP_LOCKED
  Creates the first superadmin account (users.role = 'superadmin') with the
  given password (Better Auth credential hash). The legacy admin_emails
  setting is DELETED — the env allow-list (LXK_ADMIN_EMAILS) is the only
  superadmin source, applied at provisioning only, never edited at runtime.

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
  Access: superadmin (and bare API keys) see all projects; a member session
  sees only projects it can access (explicit user_project_roles grant, else
  membership of the project's owning team). Unassigned projects (teamId null)
  are superadmin-only until assigned.

POST   /api/projects          (admin)
body { name*, slug?, description?, teamId? }
→ 201 Project | 403 FORBIDDEN | 404 TEAM_NOT_FOUND | 409 SLUG_TAKEN
  teamId = owning team (organization id); omitted/null = unassigned
  (superadmin-only until assigned). An unknown teamId → 404 TEAM_NOT_FOUND.

GET    /api/projects/:slug
→ 200 Project | 403 PROJECT_ACCESS_DENIED | 404
  The same access rule as the list: a member session without a grant or team
  membership gets 403 (FORBIDDEN, code PROJECT_ACCESS_DENIED). This gate also
  applies to every /projects/:slug/* read and to create/move/comment/etc. —
  you cannot touch a project you cannot open.

PATCH  /api/projects/:slug   (admin)
body { name?, description? }
→ 200 Project | 403 FORBIDDEN | 404

DELETE /api/projects/:slug   (admin)
→ 204 | 403 FORBIDDEN | 404 | 409 SLUG_TAKEN (constraint fallback)   (cascades: columns, swimlanes, tasks, wiki)

PATCH  /api/projects/:projectId/team   (superadmin any team; team admin own team)
body { teamId*: string | null }
→ 200 Project | 403 FORBIDDEN | 404
  teamId null = unassigned (superadmin-only until assigned). A team admin may
  only assign their own team. Projects gain teamId on the Project payload.

GET    /api/projects/:slug/repos  (admin)
→ 200 { data: [{ repo, sourceRole, workspaceRole }] } | 403 FORBIDDEN | 404
  Repo rows with roles (project_repos). Repos are managed here — the Project
  payload's repos[] is read-only (no repo fields on create/update).

PUT    /api/projects/:slug/repos  (admin)   — FULL REPLACE of the repo list
body { repos*: [{ repo*, sourceRole?, workspaceRole? }] }
  repo = "owner/name". At least one role per repo (sourceRole/workspaceRole
  default false; both false → 422). Rows missing from the payload are removed.
→ 200 { data: [{ repo, sourceRole, workspaceRole }] }
  | 403 FORBIDDEN | 404 | 400 (bad repo format or no role set — payload schema) | 409 CONSTRAINT (DB-level failure on replace)

GET    /api/dashboard
→ 200 Dashboard     (unpaginated full snapshot — health cards, stats, attention lists)
  Health derivation per project:
  - health: "exceeded" if any column has tasks > wipLimit; "approaching" if urgentCount > 0; else "ok"
  - wipSegments: one segment per column, state = compare count vs wipLimit (empty if count=0)
  - urgentCount: tasks WHERE priority = (first priority option for the project) AND column_id IN (project columns)
  - syncCount: tasks WHERE github.outOfSync = true
  urgentTasks/outOfSyncTasks capped at 50 items each
  Member sessions see only their accessible projects: health cards, stats
  totals, and the urgent/out-of-sync attention lists are all filtered to that
  set. Superadmin and bare API keys see the full snapshot.
```

### Project Members

```
GET    /api/projects/:slug/members
→ 200 { data: [{ name, email, role: "admin"|"member" }] }
  Users holding an explicit project role (user_project_roles rows — the
  cross-team grant mechanism; role values unchanged). Superadmins and plain
  team members are filtered out. Membership changes are made via
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
body { name?, color?, wipLimit?, requiredFields?, githubState?, isDone?, position? }
→ 200 Column | 403 FORBIDDEN | 404

DELETE /api/projects/:slug/columns/:id  (admin)
→ 204 | 403 FORBIDDEN | 409 HAS_CHILDREN { count }   (must migrate tasks first)
```

### Swimlanes

Swimlanes are sprint-aware: every non-backlog lane is a **sprint** (kind
`sprint`), optionally belonging to a milestone (`milestoneId`) and carrying
start/end dates (`startAt`, `dueAt`). The Backlog lane (kind `backlog`) is the
permanent system lane — one per project, never in a milestone, and it rejects
`dueAt`/`startAt`/`milestoneId`.

```
GET    /api/projects/:slug/swimlanes        → 200 { data: Swimlane[] }   (includes archived lanes)
POST   /api/projects/:slug/swimlanes   (admin)  body { name*, description?, position?, dueAt?, startAt?, milestoneId? } → 201 Swimlane | 403 FORBIDDEN
PATCH  /api/projects/:slug/swimlanes/:id  (admin) body { name?, description?, position?, dueAt?, startAt?, milestoneId? } → 200 Swimlane | 403 FORBIDDEN
  dueAt = "YYYY-MM-DD" (date-only sprint deadline); null clears.
  startAt = "YYYY-MM-DD" (sprint start); null clears.
  milestoneId must reference a milestone in the same project → 404 MILESTONE_NOT_FOUND
  startAt later than dueAt → 422 INVALID_ARGS
  Setting dueAt earlier than any live task's deadline in the lane → 409 DEADLINE_AFTER_LANE { date }
  dueAt/startAt/milestoneId on the Backlog lane → 409 BACKLOG_PROTECTED
DELETE /api/projects/:slug/swimlanes/:id  (admin) → 204 | 403 FORBIDDEN | 409 HAS_CHILDREN { count } (tasks must be reassigned first — swimlane_id is NOT NULL)
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

### Milestones

A milestone is a goal wrapper holding one or more sprints (via
`swimlanes.milestoneId`). Deleting a milestone loosens its sprints
(`milestoneId` → null); they surface as loose sprints. Archived milestones keep
their sprints (see archive cascade below).

```
GET    /api/projects/:slug/milestones → 200 { data: Milestone[] }
       (includes archived milestones; each carries sprintCount + archivedSprintCount)
POST   /api/projects/:slug/milestones   (admin)  body { name*, description?, position?, dueAt? } → 201 Milestone | 403 FORBIDDEN
PATCH  /api/projects/:slug/milestones/:id  (admin) body { name?, description?, position?, dueAt? } → 200 Milestone | 403 FORBIDDEN | 404
  dueAt = "YYYY-MM-DD" (target date); null clears.
DELETE /api/projects/:slug/milestones/:id  (admin) → 204 | 403 FORBIDDEN | 404
  | 409 HAS_CHILDREN { count }   (sprints must be loosened/reassigned first — milestone_id has ON DELETE SET NULL)

POST   /api/projects/:slug/milestones/:id/archive  (admin)
→ 200 { data: Milestone, activity: ActivityEvent[] } | 403 FORBIDDEN | 404
  One transaction: milestone archivedAt set + every sprint in the milestone
  archived, each archiving its live tasks (one `archived` activity row per
  task). Idempotent — an already-archived milestone returns unchanged.

POST   /api/projects/:slug/milestones/:id/restore  (admin)
→ 200 { data: Milestone, activity: ActivityEvent[] } | 403 FORBIDDEN | 404
  Milestone only — its sprints stay archived (restore individually). Idempotent.
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
  swimlanes carry dueAt/startAt/archivedAt/kind/milestoneId — the Backlog lane
  (kind=backlog) is the permanent system lane; every project has exactly one
  milestones: Milestone[] included (archived milestones included when
  includeArchived=true; sprintCount/archivedSprintCount always present)
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
GET    /api/projects/:slug/github/issues?repo=owner/name&q=
→ 200 { data: [{ number, title, state }] } | 404 | 502 GITHUB_API_ERROR
  Autocomplete backing for the task-detail issue picker. repo* must be a
  workspace repo of the project — a non-workspace repo → 502 GITHUB_API_ERROR.
  q optional — filter over the
  recent issues list (per_page=100; no GitHub search-API dependency); exact
  `#number` (q = "#123") does a direct issue GET fallback. Server-side cache
  ~60s TTL (new issues appear after ≤ TTL). Already-linked issues (linked to
  any task) are excluded.

POST   /api/projects/:slug/github/task-from-issue
body { repo*, issueNumber* }
→ 201 Task mutation response ({ data: Task, activity }) | 404 | 409 ALREADY_LINKED | 422 REQUIRED_FIELD | 502 GITHUB_API_ERROR
  Creates a task from an existing GitHub issue: task lands in the project's
  first column (Backlog), title + description seeded from the issue (Markdown
  → TipTap), issue auto-linked. repo must be a workspace repo. required_fields
  enforced like a normal create. ALREADY_LINKED when the issue is already
  linked to any task.

POST   /api/projects/:slug/tasks/:id/github-link
body { repo* }                   ("owner/name" — creates a GitHub issue from the task)
→ 200 Task (with github populated) | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  repo must be a WORKSPACE repo of the project — otherwise 502 GITHUB_API_ERROR.
  ALREADY_LINKED fires when the task already has an issue in the same repo
  (multi-issue: one link per repo per task).

POST   /api/projects/:slug/tasks/:id/github-link-existing
body { repo*, issueNumber* }
→ 200 Task (with github populated) | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  Links an EXISTING GitHub issue to the task (no issue created). repo must be
  a workspace repo of the project. ALREADY_LINKED when the issue is already
  linked to any task, or the task already has an issue in that repo.

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

GET    /api/settings/rate-limit  (admin)
→ 200 { max: number, windowMs: number, envOverride: boolean }
  Effective per-IP rate limit: DB settings (settings.rate_limit_max /
  settings.rate_limit_window_ms) > code defaults (6000 / 600_000 ms). The DB
  is the single source of truth — env (LXK_RATE_LIMIT_MAX / LXK_RATE_LIMIT_WINDOW_MS)
  is a first-boot bootstrap, mirrored into the DB once at boot. envOverride is
  retained for the frontend contract but is always false (env never overrides
  at runtime).

PUT    /api/settings/rate-limit  (admin)
body { max*: integer >= 1, windowMs*: integer >= 1000 }
→ 200 { max, windowMs, envOverride } — same shape as GET
  | 422 INVALID_RATE_LIMIT (non-integer, out-of-range, or missing field)
  Persists to settings.rate_limit_max / settings.rate_limit_window_ms and
  applies live via syncRateLimitFromDb (no restart). Empty rows fall back to
  the defaults; a cleared key is re-imported from env only at the next boot.

GET    /api/settings/github  (admin)
→ 200 { appId: string, privateKeySet: boolean, webhookSecretSet: boolean,
        source: "settings" | "none" }
  Effective GitHub App config: the DB is the single source of truth
  (settings.github_app_id / settings.github_private_key /
  settings.github_webhook_secret). Env (GITHUB_APP_ID / GITHUB_PRIVATE_KEY /
  GITHUB_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET) is a first-boot bootstrap,
  mirrored into the DB once at boot. source = "settings" if any github_*
  settings row exists, else "none" (no "env" state — env is never a runtime
  source).
  ⚠ Write-only secrets: the PEM and webhook secret are never returned —
  only privateKeySet / webhookSecretSet booleans.

PUT    /api/settings/github  (admin)
body { appId*: string (digits, e.g. "1234567"),
       privateKey?: string (PEM text), webhookSecret?: string }
→ 200 same shape as GET
  | 422 INVALID_GITHUB_SETTINGS (missing/invalid appId, privateKey not a PEM)
  Present field = replace; empty string = CLEAR (deletes the settings row so
  env fallback resumes); omitted field = unchanged. Applies live (holder +
  cache reset — no restart); webhook verification picks up the new secret
  immediately.

GET    /api/settings/github/search-repos?q=  (admin)
→ 200 { data: ["owner/repo", ...] } | 403 FORBIDDEN | 502 GITHUB_API_ERROR
  Linked Repos type-ahead: repos the GitHub App is INSTALLED on, filtered by q
  (owner or repo name substring). Only sees installed repos — "Only select
  repositories" installs silently shrink the results.
```

### Admin (users & project roles)

All endpoints require a superadmin caller (env-only) — everyone else gets
`403 FORBIDDEN`. Role editing is **removed**: `users.role` derives solely from
the env allow-list, never from a runtime endpoint (the legacy
`PATCH /api/admin/users/:id { role }` is deleted — user lifecycle goes through
`/api/workspace/members`).

```
GET    /api/admin/users
→ 200 { data: [{ id, email, name, role, createdAt, lastSeen }] }   (role: "superadmin"|"member")

GET    /api/admin/users/:id/projects
→ 200 { data: [{ projectId, projectSlug, role: "admin"|"member" }] }
  (project grant roles stay "admin"|"member" — user_project_roles is the
  cross-team explicit-grant mechanism, unchanged)

PUT    /api/admin/users/:id/projects    body { projectId*, role*: "admin"|"member" }
→ 200 { projectId, projectSlug, role }
  | 403 FORBIDDEN
  (wire quirk: projectSlug currently echoes projectId)

DELETE /api/admin/users/:id/projects/:projectId
→ 204 | 403 FORBIDDEN
```

### Me (self-service profile)

The acting user is the session user (cookie); bare API keys without a session
get `400 NO_USER_CONTEXT` — agents have no profile to edit.

```
PATCH  /api/me      body { name*: string (trimmed, 1-80 chars) }
→ 200 { id, email, name, role, createdAt, lastSeen }
  | 400 NO_USER_CONTEXT | 404 USER_NOT_FOUND | 422 INVALID_NAME
```

Password change is a Better Auth endpoint (`/api/auth/change-password`,
revokes other sessions) — see the auth route surface. Identity for the UI
comes from `GET /api/auth/get-session`; the `lxk-user` / `lxk-logout` meta
tags are removed.

### Teams (auth-roles-teams)

A team is a Better Auth organization (`organization` table, slug unique);
membership is one `member` row per (team, user) with an independent org role.
Team admin = org member with role `owner` | `admin`; team admins manage own
team only, the superadmin manages all teams. There are no email invites at
team level — membership is granted by adding an existing workspace member.

```
GET    /api/teams
→ 200 { data: Team[] }     (team admin: own teams; superadmin: all teams)

POST   /api/teams          (superadmin only)
body { name*, slug? }
→ 201 Team | 403 FORBIDDEN | 409 SLUG_TAKEN
  Creator becomes the org owner (member role 'owner').

DELETE /api/teams/:teamId  (superadmin only)
→ 204 | 403 FORBIDDEN | 404
  | 409 TEAM_HAS_PROJECTS { count }   (blocked while the team owns projects — reassign first)
  Cascades: memberships; owning projects' team_id → NULL.

GET    /api/teams/:teamId/members     (team admin own team / superadmin)
→ 200 { data: TeamMember[] }

POST   /api/teams/:teamId/members     (team admin own team / superadmin)
body { email*, role*: "owner"|"admin"|"member" }
→ 201 TeamMember | 403 FORBIDDEN | 404
  | 422 — email is not an existing workspace member: error carries a
    details.available* hint (invite via superadmin first)
  Adds an EXISTING workspace member — no accept step, no team-level invites.

PATCH  /api/teams/:teamId/members/:userId   (team admin own team / superadmin)
body { role*: "owner"|"admin"|"member" }
→ 200 TeamMember | 403 FORBIDDEN | 404
  | 403 SOLE_OWNER   (demoting/removing the last owner — transfer first)

DELETE /api/teams/:teamId/members/:userId   (team admin own team / superadmin)
→ 204 | 403 FORBIDDEN | 404 | 403 SOLE_OWNER
  Removes that team's access immediately; other teams unaffected.
```

### Workspace (members, invites, set-password links)

Superadmin-only surfaces. The workspace = the app's member base (all users),
before and across team placement.

```
GET    /api/workspace/members   (superadmin)
→ 200 { data: Array<LexaUser & { teams: Array<{ teamId, teamName, role }> }> }
  All users with role, team memberships, and last seen.

PATCH  /api/workspace/members/:userId   (superadmin)
body { action*: "deactivate" | "reactivate" }
→ 200 LexaUser | 403 FORBIDDEN | 404 USER_NOT_FOUND
  Deactivate = ban: blocks login and rejects existing sessions on the next
  check. Role/grants are preserved for reactivation.

DELETE /api/workspace/members/:userId   (superadmin)
→ 204 | 403 FORBIDDEN | 404 USER_NOT_FOUND
  Removes memberships + project grants and REVOKES the user's bound API keys
  (a deleted user's key must not survive unbound). Activity/comments keep
  their rows (author_id → NULL).

POST   /api/workspace/invites    (superadmin)
body { email* }
→ 201 { link } | 403 FORBIDDEN | 409 (invite already pending for that email)
  link = {baseURL}/invite?token=<secret> — shared out-of-band (no email
  transport). Expires 7d after issue. Accepting on first login sets the
  password → member account created → accepted_at stamped; re-use idempotent.

POST   /api/auth/invite/accept    (keyless, session-less — the token is the auth)
body { token*, name*, password* }    (password min 8 chars)
→ 200 { status: true, email } | 400 { code }
  Consumes a workspace invite: validates the token (unknown / expired /
  already accepted → 400 `INVALID_TOKEN`; the email already has an account →
  400 `USER_EXISTS`, invite left pending — the account needs a superadmin
  set-password link instead). Creates the member account (credential
  password) and stamps accepted_at. Error body is flat: `{ "code": ... }`
  (native better-auth shape — NOT the `{ error: {...} }` REST envelope).

GET    /api/workspace/invites    (superadmin)
→ 200 { data: Array<{ id, email, expiresAt }> }
  Pending invites only (accepted_at IS NULL) — the Members UI renders the
  revoke list from this. | 403 FORBIDDEN

DELETE /api/workspace/invites/:inviteId   (superadmin; pending only)
→ 204 | 403 FORBIDDEN | 404 | 409 (already accepted — cannot revoke)
  Revoked links die.

POST   /api/workspace/members/:userId/set-password-link   (superadmin)
→ 201 { link } | 403 FORBIDDEN | 404 USER_NOT_FOUND
  link = {baseURL}/set-password?token=<secret> — verification table token,
  single-use, 7d expiry. Covers forgotten/no passwords (legacy users).
```

### Sessions (self-service)

```
GET    /api/sessions
→ 200 { data: SessionInfo[] }     (own sessions only, newest first)

POST   /api/sessions/:sessionId/revoke
→ 204 | 404
  Own sessions only — revoking another user's session id → 404 (no existence
  oracle). Logout / password change / deactivate also revoke sessions.
```

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
body { id?, name*, provider*: "opencode"|"hermes"|"command-code", machineId*, model?, hostname?, teamId? }
→ 201 Runtime
  teamId omitted/NULL = global runtime (superadmin-owned; claims any team's
  project tasks). A non-null teamId scopes the runtime to that team's tasks.
  (R13: team admin registers for own team; superadmin any team + global.)

PATCH  /api/forge/runtimes/:id              (browser)
body { name?, provider?, agent?, model?, printLogs?, logLevel?, extraArgs?: string[] }   (server-authoritative config)
→ 200 Runtime
  | 404 RUNTIME_NOT_FOUND
  (team admin: own team's runtimes only; superadmin: all + global)
Edits apply to the daemon's next claim — no restart needed. provider switches
which CLI the daemon spawns (the daemon machine must have it installed);
agent is the CLI's internal persona flag (opencode --agent build/plan; empty =
default) — labelled "Persona" in the UI to distinguish it from Lexa's own
agents (rule bundles). extraArgs are appended verbatim to the agent CLI spawn
(no shell). model stores the full "provider/model" id (e.g. "opencode/deepseek-v4-flash") —
passed verbatim
to --model. hostname/status are daemon-reported and not editable.

GET    /api/forge/runtimes?teamId=
→ 200 { data: Runtime[] }                  (offline if last_seen > 2 min ago)
  ?teamId= filter: team admin — own team only; superadmin — any team, plus
  global (team_id NULL) runtimes. Claim rule: a runtime claims a forge task
  only when team_id IS NULL (global) OR team_id = the task's project.team_id.

DELETE /api/forge/runtimes/:id              (browser)
→ 204 | 404 RUNTIME_NOT_FOUND
  (team admin: own team's runtimes only; superadmin: all + global)
Removal never blocks: it queues a machine-scoped `remove` event (delivered
whenever the machine's listener next heartbeats — the listener kills the
matching child + env directory) and deletes the runtime row. A machine hosts
at most one runtime per agent CLI, so the whole (machine, provider) pair is
removed — keeping host state consistent with the provider-scoped event.
Runtimes without a machine are deleted directly.

POST   /api/forge/daemon/heartbeat         (daemon child)
body { runtimeId* }
→ 200 { ok: true }
The daemon reports liveness. `lexa-cli machine listen` discovers
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
        agentMarkdown: string, skillMarkdown: string, skillIds: string[],
        repoContent: [{ owner, repo, path, content }],
        runtimeSessionId: string | null, agentId: string, skillId: string }
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
  (files-only delivery, no host store).
  repoContent: best-effort linked-repo files for grounding (Contents: Read) —
  [] when the task links no GitHub repo, GitHub is unconfigured, or any fetch
  failed (a claim never fails for missing context). The daemon writes them
  into repo-content/ (+ MANIFEST.md) and the prompt points the agent there.
  owner = the GitHub owner, repo = full "owner/repo", path = repo-relative
  path, content = UTF-8 text (≤ 256 KB per file, ≤ 512 KB total, ≤ 50 files,
  ≤ 3 repos).
  runtimeSessionId: the warm-session continue-vs-mint verdict — the mapped
  runtime session id when a forge_sessions row exists for (documentType,
  documentId, runtimeId) AND its agent/skill match the task's, else null
  (the daemon then mints a fresh session on its serve server). agentId/skillId
  are the task's own — what a future mapping must match. Only meaningful for
  provider "opencode"; hermes/command-code ignore it.)

# ── Forge warm sessions (document ↔ runtime agent conversation mapping) ──
GET    /api/forge/sessions?documentType=&documentId=   (browser)
→ 200 { data: Array<ForgeSession> }
ForgeSession = { documentType, documentId, runtimeId, runtimeSessionId,
  provider, agentId, skillId, createdAt, updatedAt } (camelCase)
The mapping tells which agent-side conversation (opencode serve session id)
the next Forge task on this document should continue. Missing/invalid query
params → { data: [] } (sessions are document-agnostic metadata — never 404).

PUT    /api/forge/sessions                   (daemon)
body { documentType*, documentId*, runtimeId*, runtimeSessionId*, provider*,
       agentId*, skillId* }
→ 204
Upsert called by the daemon BEFORE the run starts (pre-spawn mapping write,
spec §8 step 3) and to rewrite the row on stale-session retry. provider is
"opencode"|"hermes"|"command-code"; only opencode writes rows in v1.

DELETE /api/forge/sessions                   (daemon)
body { documentType*, documentId*, runtimeId* }
→ 204
Daemon-side drop on cancel/timeout. Always allowed — NEVER 409: the in-flight
run is gone, nothing will re-write the row.

POST   /api/forge/sessions/reset             (browser)
body { documentType*, documentId*, runtimeId* }
→ 204 | 409 FORGE_SESSION_ACTIVE
User-facing reset: deletes the mapping row so the next run mints a new
session. 409 while a task on this document+runtime is queued or running —
otherwise the run's completion would re-write the row the user just deleted
and silently undo the reset. Deleting a missing mapping is 204, never 404.

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
`~/.lexa/<host>/machine-secret` (chmod 600).

POST   /api/forge/machines/heartbeat          (listener)
body { id*, hostname?, clis?: [{ provider, version }],
       runtimes?: [{ runtimeId, agentCli, models, agents }],
       daemonErrors?: [{ runtimeId, error }] }
→ 200 Machine & { projects: [{ id, name, slug, description }] }
  projects = full project index; the listener provisions one workspace dir
  per project under ~/.lexa/<host>/projects/ and keeps its local lookup fresh.
Upserts a machine row (marks it listening). The CLI persists id in
~/.lexa/<host>/machine-id. clis = installed agent CLIs probed at listener start
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
  | 502 SOURCE_FETCH_ERROR                 (bad URL / private-IP block / fetch failed upstream)
  | 422 SOURCE_UNREACHABLE                 (DNS or connection failure after the SSRF guard)

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
- **Forge loop:** the spawned agent CLI receives a server-built prompt; the
  one-shot result is returned to the editor for accept/reject.

## Notes

- **Mutation responses are authoritative.** Every mutating endpoint returns the updated entity. The frontend updates TanStack Query cache from the response (`setQueryData`) and never refetches on the mutation path — the response is the authoritative state.
- **`position` is opaque.** Clients never read or write it directly; ordering is expressed via `beforeTaskId`/`afterTaskId` (tasks) or `position` integer reassignment (columns/swimlanes/wiki siblings).
- **`:slug` in task routes is routing context**, not an authorization boundary. Project access is enforced by the authorization service (superadmin > explicit `user_project_roles` grant > team membership > deny); team admins act within their own teams only. Task IDs are globally unique UUIDs.
