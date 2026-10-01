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
| 403 | `FORBIDDEN` | Superadmin- or team-admin-gated endpoint called without authority, or project access denied (details: `{ message }`) |
| 403 | `SETUP_LOCKED` | Mutating `/api/setup/*` call after setup is complete or projects exist |
| 403 | `SOLE_OWNER` | Demoting or removing the last owner of a team (details: `{ message }` — transfer ownership first) |
| 403 | `CANNOT_DELETE_SELF` | Removing the last superadmin / self-removal via the workspace member routes (details: `{ message }`) |
| 404 | `USER_NOT_FOUND` | Unknown user id on admin/workspace/team-member endpoints |
| 404 | `TEAM_NOT_FOUND` `INVITE_NOT_FOUND` `SESSION_NOT_FOUND` | Unknown team / invite / own-session id |
| 404 | `PROJECT_NOT_FOUND` `COLUMN_NOT_FOUND` `SWIMLANE_NOT_FOUND` `MILESTONE_NOT_FOUND` `TASK_NOT_FOUND` `PAGE_NOT_FOUND` `SOURCE_NOT_FOUND` `ASSISTANT_TASK_NOT_FOUND` `TASK_LINK_NOT_FOUND` `API_KEY_NOT_FOUND` `AGENT_NOT_FOUND` `SKILL_NOT_FOUND` | |
| 404 | `SHARE_LINK_NOT_FOUND` | Wiki share link unknown, expired, or revoked — all three return this identical envelope (no existence oracle) |
| 404 | `ATTACHMENT_NOT_FOUND` | Unknown attachment id, blob missing, or attachment outside the shared subtree on the share route |
| 409 | `SLUG_TAKEN` | Duplicate project slug, wiki slug, or team slug (details: `{ slug }`); also the constraint fallback on project update/delete |
| 409 | `INVITE_PENDING` | An invite is already pending for that email (details: `{ email }`) |
| 409 | `TASK_HAS_CHILDREN` | Task delete hits a constraint (defensive — subtask links cascade on delete) |
| 409 | `TASK_LINK_CYCLE` | subtask_of link would create a cycle (details: `{ message }`) |
| 409 | `HAS_CHILDREN` | Delete column with tasks / wiki page with children / milestone with sprints (details: `{ count }`) |
| 409 | `WIP_LIMIT` | Move would exceed column WIP limit |
| 409 | `BACKLOG_PROTECTED` | Archive/delete or deadline changes on the system Backlog lane (details: `{ action }`) |
| 409 | `DEADLINE_AFTER_LANE` | Task deadline later than its lane's due date (details: `{ date }`) |
| 409 | `ALREADY_LINKED` | Task already has a GitHub issue in that repo |
| 409 | `OPTION_IN_USE` | Delete priority/type option still referenced by tasks (details: `{ optionId, label }`) |
| 409 | `AGENT_ENTITY_IN_USE` | Delete agent/skill still used by assistant tasks (details: `{ kind, name, count }`) |
| 409 | `TEAM_HAS_PROJECTS` | Delete team while it owns projects (details: `{ count }` — reassign projects first) |
| 409 | `CONSTRAINT` | Generic constraint-violation fallback (typed codes like `SLUG_TAKEN` / `HAS_CHILDREN` / `OPTION_IN_USE` are raised whenever possible) |
| 413 | `BODY_TOO_LARGE` | Request body exceeds `LXK_MAX_BODY_MB` (default 16) — early gates, before auth: stream cap in `server/entry.ts` (chunked/CL-less bodies included) + declared-length pre-check in the API middleware. Attachment-upload paths get a raised cap (`LXK_MAX_UPLOAD_MB` + multipart slack) so legit uploads reach the route. |
| 413 | `PAYLOAD_TOO_LARGE` | Uploaded file exceeds `LXK_MAX_UPLOAD_MB` (default 25) — enforced at the route after multipart parse (details: `{ size, maxBytes }`). Chat attachment uploads use their own per-file cap of 5 MB (`CHAT_ATTACHMENT_MAX_UPLOAD_BYTES`) independent of `LXK_MAX_UPLOAD_MB` (details: `{ size, maxBytes, filename }`) |
| 403 | `ATTACHMENT_DELETE_FORBIDDEN` | Attachment delete without uploader/admin authority |
| 403 | `CHAT_ATTACHMENTS_DISABLED` | Chat attachment upload or a chat send carrying attachments while `LXK_DISABLE_CHAT_ATTACHMENTS=1` |
| 403 | `TASKS_BULK_DISABLED` | `POST /projects/:slug/tasks/bulk` while `LXK_DISABLE_TASKS_BULK=1` — refused before any write |
| 422 | `REQUIRED_FIELD` | Column's `required_fields` not satisfied (details: `{ field, column }`) |
| 422 | `NEIGHBOR_NOT_IN_COLUMN` | `beforeTaskId`/`afterTaskId` not in target column (details: `{ taskId }`) |
| 422 | `INVALID_OPTION` | Unknown priority/type option id, duplicate label, or empty option list (details: `{ optionId? }`) |
| 422 | `INVALID_TASK_LINK` | Self-link or cross-project task link (details: `{ message }`) |
| 422 | `AGENT_BUILTIN_DELETE` | Delete/reset of a builtin agent or skill (details: `{ kind, name }`) |
| 422 | `SEARCH_ERROR` | Wiki FTS5 query rejected |
| 422 | `INVALID_PARENT` | Wiki reparent: self, cross-project, or descendant cycle (details: `{ reason: "self" \| "cross-project" \| "cycle" }`) |
| 422 | `SOURCE_UNREACHABLE` | External source DNS/fetch failed after the SSRF guard (details: `{ url }`) |
| 422 | `API_KEY_NAME_EMPTY` | API key name missing or blank |
| 422 | `NOT_WORKSPACE_MEMBER` | Team-member add targets an email that is not a workspace member (details: `{ email, available }` — invite via the superadmin first) |
| 422 | `INVALID_ARGS` | Sprint start date later than its due date (details: `{ reason }`); Assistant attachment scope/cap violations; bulk move with neither `columnId` nor `swimlaneId`; bulk with more than 100 `ids` (details: `{ reason }`) |
| 422 | `ATTACHMENT_EXTRACTION_FAILED` | A chat document attachment's bytes yielded no model-visible text (unreadable PDF, non-UTF-8 text) — the send is blocked, the file named (details: `{ filename, reason }`) |
| 429 | `RATE_LIMITED` | Per-IP rate limit exceeded on `/api/*` (one shared bucket; `/api/setup*` + `/api/health` ARE limited; `/api/share/*` uses a dedicated stricter bucket) — enforced in the API middleware |
| 500 | `DATABASE_ERROR` / `INTERNAL` | |
| 500 | `PASSWORD_LINK_FAILED` | Admin-issued set-password link could not be issued (details: `{ message }`) |
| 502 | `GITHUB_API_ERROR` | Only on explicit GitHub-linking endpoints; never on moves |
| 502 | `SOURCE_FETCH_ERROR` | External source fetch failed upstream after the SSRF guard (details: `{ message }`) |
| 409 | `PROVIDER_NOT_CONFIGURED` | Assistant generate/test/chat without saved provider settings for the project |
| 502 | `PROVIDER_AUTH_FAILED` | Upstream 401/403 from the provider or Exa |
| 502 | `PROVIDER_UNREACHABLE` | Provider network/timeout/DNS failure |
| 502 | `ASSISTANT_GENERATION_FAILED` | RUN_ERROR catch-all, malformed stream |
| 502 | `ASSISTANT_TOOL_BUDGET_EXCEEDED` | Tool round cap hit (document tasks `MAX_TOOL_ROUNDS=12`, freeform chat `MAX_CHAT_TOOL_ROUNDS=24`) |
| 409 | `ASSISTANT_TASK_ACTIVE` | Thread reset or second chat stream while an Assistant stream is running |
| 404 | `ASSISTANT_THREAD_NOT_FOUND` | Missing Assistant thread row |
| 409 | `VISION_NOT_CONFIGURED` | Attachments submitted while `primary_supports_images=0` (vision_model delegation removed in the squashed baseline) |
| 400 | `SECRET_KEY_UNAVAILABLE` | A managed provider key or Jev key was submitted but `LXK_SECRETS_MASTER_KEY` is unset or malformed (an MCP token save is refused as `MCP_INVALID_TRANSPORT_CONFIG` instead) |
| 400 | `JEV_INVALID_CONFIG` | Jev registry payload refused: `clearSecret` + `secret`, invalid base URL, or model length (details: `{ reason }`) |
| 502 | `JEV_AUTH_FAILED` | Jev rejected the stored API key (upstream 401/403) |
| 502 | `JEV_UNREACHABLE` | Any non-401/403 Jev failure — network/timeout/5xx, rate limit, or an unreadable response |
| 400 | `GITHUB_MANIFEST_STATE_INVALID` | Manifest-connect state unknown, already used, expired, or mismatched — one code for every failure (no existence oracle), and the state row is consumed on every attempt |
| 422 | `GITHUB_MANIFEST_PERMISSIONS_DENIED` | The App GitHub created reports a required permission missing or at the wrong level (defensive; a report with no permissions is not a denial) |
| 502 | `GITHUB_MANIFEST_EXCHANGE_FAILED` | The one-time manifest `code` could not be exchanged with GitHub (non-2xx or a payload without credentials) |
| 500 | `GITHUB_SECRET_WRITE_FAILED` | Encrypted GitHub credential write refused — `LXK_SECRETS_MASTER_KEY` unset/malformed or a DB error (the connect path never falls back to plaintext) |

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
  `api_keys`; `last_used_at` is bumped at most hourly. Keys are **user-bound**:
  a key carries the acting user (session-equivalent identity + project
  access from `user_project_roles`/team membership) and the owner's role
  (superadmin→admin, member→member). Member-bound keys call the same
  per-project authorization gates as member sessions and are 403'd on
  admin/superadmin gates (`requireSuperadmin` etc). `user_id` NULL =
  **server key** (legacy rows from pre-change installs and dev `setup-cli`
  only — never created through the UI): resolves to role admin. Key auth for CLI/webhooks is
  unchanged. UI-created keys always bind to the creating user (a key created
  by a superadmin keeps full admin power, attributed to that user).

**Attribution (R5):** the actor is the session user for browser calls and the
key name for machine calls. The `x-lxk-user` header is **removed** — never
sent by browsers, never read by the server. The `<meta name="lxk-api-key">`
injection is removed — browsers authenticate `/api/*` via the session cookie.

- **Superadmin vs member:** `users.role` ∈ {superadmin, member} — superadmin is
  env-only (`LXK_ADMIN_EMAILS`, applied at provisioning via the setup wizard),
  never edited at runtime (no role-editing endpoint; legacy `admin` → `superadmin`).
  A `requireSuperadmin` gate (403 `FORBIDDEN`) protects project
  create/update/delete, column and swimlane mutations, `PUT field-config`, all
  `/api/settings/*`, all `/api/admin/*`, Assistant agent/skill CRUD + reset + skill
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
  - `GET /api/share/:token` — public wiki share links (capability URL: no key,
    no session). Still IP-rate-limited with a dedicated stricter bucket;
    security headers unchanged. Unknown/expired/revoked tokens return the
    identical generic 404 (no existence oracle). `GET
    /api/share/:token/attachments/:id` joins this exemption — same bucket,
    token validated per request.
  - `POST /api/webhooks/github` — HMAC-SHA-256 signature over the raw body is the auth
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
  sourceRole: boolean;            // Assistant grounding + project label
  workspaceRole: boolean;         // issue link/create/sync
}

interface Project {
  id: ID;
  name: string;
  slug: string;
  key: string;                // ticket-key prefix (e.g. "NIM") — unique per project
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
  title: string | null;         // last-known upstream GitHub title; null = unknown
  syncedState: "open" | "closed" | null;
  url: string;                  // derived: github.com/<repo>/issues/<n>
  outOfSync: boolean;           // derived: syncedState !== column's githubState (state divergence)
  pushFailed: boolean;          // last Lexa→GitHub content push failed (content divergence)
}
// Divergence text on a linked row = outOfSync ("out of sync — state") +
// pushFailed ("— edit not pushed"); both → "— both".

interface Task {
  id: ID;
  key: string;                // ticket key "PREFIX-n" (e.g. "NIM-12") — immutable, unique per project
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
  updatedBy: ID | null;       // users.id of the last save; null = legacy/unknown
  updatedByName: string | null;  // resolved on single-page payloads; list/tree/search emit null
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

interface AssistantTask {
  id: ID;
  key: string;             // ticket key of the document task ("" for wiki) — display only
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

interface Attachment {
  id: ID;
  projectId: ID;
  taskId: ID | null;      // exactly one of taskId / wikiPageId
  wikiPageId: ID | null;
  filename: string;       // sanitized (basename, control chars stripped, ≤255)
  mimeType: string;       // SERVER-SNIFFED at upload — client mime never stored
  sizeBytes: number;
  sha256: string;         // hex; dedupe key per project — UNIQUE(project_id, sha256)
  uploadedBy: ID | null;  // session user or key owner; NULL = unbound key
  uploadedByLabel: string | null;  // users.name resolved server-side
  createdAt: ISODate;
}
// Upload dedupe: re-uploading identical bytes to the same project returns the
// EXISTING row unchanged (no second activity row, no blob rewrite). Blobs are
// content-addressed globally by sha256 and deleted when the last referencing
// row goes. Serving: inline ONLY for image/* + application/pdf — everything
// else downloads via Content-Disposition: attachment (+ nosniff always).

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
→ 200 { configured: boolean, needsAdmin: boolean,
        hasProjects: boolean, hasUsers: boolean }
  API-key exempt. configured = setup_complete flag OR (api key + superadmin present).

POST   /api/setup/admin        body { email*, password* }
→ 200 { ok: true } | 403 SETUP_LOCKED
  Creates the first superadmin account (users.role = 'superadmin') with the
  given password (Better Auth credential hash). First install is free-choice
  provisioning: the operator picks any email in the wizard.
  LXK_ADMIN_EMAILS is the CLI bootstrap default only — it never gates or
  pre-populates the wizard. The legacy admin_emails setting is DELETED.

POST   /api/setup/seed        body { flavor?: "minimal" | "full" }
→ 200 { seeded: boolean }
  Loads scripts/seed-minimal.sql or scripts/seed-dev.sql (default full) into
  an empty DB (every environment). seeded=false if the file is
  missing or the DB already has
  projects. Task keys are backfilled after loading.

POST   /api/setup/complete
→ 200 { ok: true } | 403 SETUP_LOCKED
  Sets setup_complete=1.

The mutating setup endpoints fail 403 SETUP_LOCKED once setup_complete=1,
any project exists (in-use instance), or the instance is env-provisioned
(api key + LXK_ADMIN_EMAILS) — the wizard only runs on first install.
/setup/complete omits the projects branch: the wizard's own sample-data
step creates projects immediately before complete, so counting them
there would deadlock every seeded first install.
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
             inserts a subtask_of link); accepts the ticket key (PREFIX-N) alias
  dueAt = "YYYY-MM-DD" — must not be later than the lane's due date (when it has one)
→ 201 Task
  | 404 COLUMN_NOT_FOUND / SWIMLANE_NOT_FOUND / TASK_NOT_FOUND (bad parentId)
  | 409 DEADLINE_AFTER_LANE        (dueAt later than lane due)
  | 422 REQUIRED_FIELD            (creating directly into a guarded column)
  | 422 INVALID_OPTION            (bad priority/type id)
  position: appended to end of column

GET    /api/projects/:slug/tasks/:id
→ 200 Task | 404
  `:id` accepts the ticket key (PREFIX-N, e.g. "NIM-12") as a lookup alias —
  resolved via the project's key prefix + number (server/api/task-id.ts).
  The same alias is accepted for task ids carried in payloads/query on the
  endpoints that resolve them: `parentId` on POST /tasks, `toTaskId` on
  POST /tasks/:id/links, `beforeTaskId`/`afterTaskId` on POST /tasks/:id/move,
  `exclude` on GET /tasks/search, and the `:id` of `/documents/task/:id/sources`
  (`:type=task`). A resolvable key becomes the task UUID; a UUID is
  passed through unchanged. On `exclude` (a filter, not a lookup) an
  unresolvable key is ignored — no exclusions, never a 404.

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
  - beforeTaskId/afterTaskId accept the ticket key (PREFIX-N) alias
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

POST   /api/projects/:slug/tasks/bulk
body { ids*, action*, columnId?, swimlaneId?, priority?, type?, assignees?, dueAt? }
  action = "move" | "update" | "archive" | "restore"
  One transaction (invariant #12 parity): every applied task runs the SAME
  service path as its single-task endpoint, so activity rows, required_fields
  and WIP guards match exactly. Position-only reorders emit nothing.
  - ids accept the ticket key (PREFIX-N) alias like every other task-id
    surface (invariant #13); unresolvable keys pass through and fail per task.
    They are de-duped first-seen (so `applied` never echoes a repeated id) and
    capped at 100 per request — a longer list is 422 INVALID_ARGS before any
    write.
  - move: columnId/swimlaneId override the task's current value; at least one
    is required. A lane-only move keeps the task's column. Each task is
    evaluated independently, so WIP/required_fields/deadline rejections are
    collected per task while the permitted tasks still move.
  - update: only the provided priority/type/assignees/dueAt change.
  - archive / restore: idempotent, exactly like the single-task endpoints.
  Side effect (after the transaction commits, best-effort — a GitHub failure
  never fails the request): update pushes content for linked tasks
  (syncContentFromLexa), and move to a github-mapped target column pushes state
  (syncStateFromLexa). Same orchestration as the single-task routes; the
  service itself makes no GitHub calls.
→ 200 { applied: string[], failed: [{ id, code, message }] }
  `applied`/`failed[].id` are the RESOLVED task ids (aliases → UUIDs).
  Per-task domain rejections are collected in `failed` while the rest apply:
  TASK_NOT_FOUND, COLUMN_NOT_FOUND, SWIMLANE_NOT_FOUND, WIP_LIMIT,
  REQUIRED_FIELD, NEIGHBOR_NOT_IN_COLUMN, INVALID_OPTION, DEADLINE_AFTER_LANE.
  Request-level failures return the standard error envelope and abort the
  transaction — NO task changes:
  | 403 TASKS_BULK_DISABLED (`LXK_DISABLE_TASKS_BULK=1`)
  | 404 PROJECT_NOT_FOUND
  | 422 INVALID_ARGS (targetless move: neither columnId nor swimlaneId;
    more than 100 ids)

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

### Attachments

Multipart upload (`multipart/form-data`, single file field `file`). Sizes are
small-medium; downloads stream through the Bun server proxy — NO presigned
URLs anywhere. Upload cap: `LXK_MAX_UPLOAD_MB` (default 25) → 413
`PAYLOAD_TOO_LARGE`. The global body cap (`BODY_TOO_LARGE`) is raised on the
upload paths so a legit large upload never trips it first.

```
POST   /api/projects/:slug/tasks/:taskId/attachments      (multipart, field "file")
→ 201 Attachment | 404 TASK_NOT_FOUND / PROJECT_ACCESS_DENIED | 413 PAYLOAD_TOO_LARGE
  Task attachments emit an `attachment_added` activity row in the same
  transaction (returned as `activity` per the mutation-response rule).
  Dedupe hit (same project + sha256) → 201 Attachment with the EXISTING row
  unchanged and `activity: []` (no second activity row, no blob rewrite).

GET    /api/projects/:slug/tasks/:taskId/attachments
→ 200 { data: Attachment[] } — oldest first (created_at ASC, id ASC)
| 404 TASK_NOT_FOUND / PROJECT_ACCESS_DENIED

POST   /api/projects/:slug/wiki/pages/:pageSlug/attachments   (multipart, field "file")
→ 201 Attachment | 404 PAGE_NOT_FOUND / PROJECT_ACCESS_DENIED | 413 PAYLOAD_TOO_LARGE
  Wiki-page uploads emit NO activity (wiki has no timeline). Same dedupe rule.

GET    /api/projects/:slug/wiki/pages/:pageSlug/attachments
→ 200 { data: Attachment[] } — oldest first (created_at ASC, id ASC)
| 404 PAGE_NOT_FOUND / PROJECT_ACCESS_DENIED

GET    /api/attachments/:id
→ 200 binary (Content-Type = sniffed mime; Content-Disposition inline for
   image/* + application/pdf, attachment otherwise; X-Content-Type-Options:
   nosniff always)
| 404 ATTACHMENT_NOT_FOUND (unknown id or blob missing) | 403 PROJECT_ACCESS_DENIED

DELETE /api/attachments/:id
→ 204 | 404 ATTACHMENT_NOT_FOUND | 403 ATTACHMENT_DELETE_FORBIDDEN
  Authority: uploader OR project admin (superadmin / project grant admin /
  team admin of the owning org). Task attachments emit `attachment_removed`
  in the same transaction. The blob is deleted only when no other row
  references its storage_key.
```

Event types added: `attachment_added` · `attachment_removed`.

### Chat attachments (Assistant conversation context)

Temporary, thread-scoped context — a separate surface from the project
attachments above (see `docs/SCHEMA.md` → Chat attachments). One capability
flag gates the composer: `GET /api/capabilities` reports `chatAttachments`
(true only where the assistant is available and the kill switch is off). With
`LXK_DISABLE_CHAT_ATTACHMENTS=1` every upload and every send carrying
attachments is refused with 403 `CHAT_ATTACHMENTS_DISABLED`, regardless of the
flag. Kill switch default is enabled (feature ON).

Upload accepts images (`image/png` `image/jpeg` `image/webp` `image/gif`) and
documents (`application/pdf` `text/markdown` `text/plain`). The stored mime is
SERVER-SNIFFED (magic bytes; content with no signature is UTF-8-probed and
extension-classified — `.md`/`.markdown` → `text/markdown`, else
`text/plain`); a sniffed-but-unsupported type (SVG/BMP/ICO/XLSX) is rejected
`INVALID_ARGS`. Per-file cap is 5 MB
(`CHAT_ATTACHMENT_MAX_UPLOAD_BYTES`, independent of `LXK_MAX_UPLOAD_MB`);
zero-byte files are rejected. Send-time caps: ≤3 attachments per message
(images + documents share the count), ≤10 MB per message. Errors name the file.

```
POST   /api/projects/:slug/assistant/chat/:chatId/attachments   (multipart, field "file")
→ 201 { data: ChatAttachment }
  | 404 PROJECT_ACCESS_DENIED / PROJECT_NOT_FOUND
  | 404 ASSISTANT_THREAD_NOT_FOUND
  | 403 CHAT_ATTACHMENTS_DISABLED | 413 PAYLOAD_TOO_LARGE | 422 INVALID_ARGS
  The thread row is created lazily (ON CONFLICT DO NOTHING), so an attachment
  may arrive before the first send. No activity row.

GET    /api/projects/:slug/assistant/chat/:chatId/attachments
→ 200 { data: ChatAttachment[] } — oldest first (created_at ASC, id ASC)
  | 404 PROJECT_ACCESS_DENIED / PROJECT_NOT_FOUND
  | 404 ASSISTANT_THREAD_NOT_FOUND

GET    /api/chat-attachments/:id
→ 200 binary (Content-Type = sniffed mime; Content-Disposition inline for
   image/* + application/pdf, attachment otherwise; X-Content-Type-Options:
   nosniff always)
  | 404 ATTACHMENT_NOT_FOUND (unknown id or blob missing) | 403 PROJECT_ACCESS_DENIED
  | 404 ASSISTANT_THREAD_NOT_FOUND

DELETE /api/chat-attachments/:id
→ 204 | 404 ATTACHMENT_NOT_FOUND | 403 ATTACHMENT_DELETE_FORBIDDEN
  Authority: uploader OR project admin. The blob is deleted only when no other
  row (task/wiki or chat) references its storage_key.
```

list/upload require thread ownership; serve requires the thread owner or a
project admin.

`ChatAttachment` = `{ id, projectId, chatId, filename, mimeType, sizeBytes,
sha256, storageKey, uploadedBy, uploadedByLabel, createdAt }`. A send
references these by `storageKey`; the server verifies the row belongs to the
project and that the declared mime matches the stored (sniffed) mime. Text and
Markdown decode directly; PDFs extract through `unpdf` server-side; a document
that yields no text blocks the send with 422 `ATTACHMENT_EXTRACTION_FAILED`.

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
  (webhook-driven) · `assistant_completed` · `assistant_failed` · `assistant_cancelled` ·
  `runtime_completed` · `runtime_failed` · `runtime_cancelled` (legacy/historical only) ·
  `commented` · `comment_deleted`.
- Messages frozen at write time (e.g. `"Maria moved from In Progress to Done"`).
  Column renamed later → old messages keep the old name (by design).

**Response envelope rule (invariant #6):** all task mutation responses include
`activity?: ActivityEvent[]` (the rows appended by that mutation) — e.g.
create/update/move/archive/restore return `{ data: Task, activity }`; link/source
adds and GitHub link/unlink likewise. Clients prepend them to the timeline cache
via `setQueryData`; never `invalidateQueries` on the mutation path. Webhook-driven
entries appear on the next slideover open (documented).

### Mentions (@-autocomplete)

```
GET    /api/projects/:slug/mentions?q=
→ 200 { data: { tasks: [{ id, key, title }],
                wikiPages: [{ id, slug, title }],
                milestones: [{ id, name, slug, sublabel }],
                swimlanes: [{ id, name, slug, sublabel }],
                columns: [{ id, name, slug, sublabel }] } }
  Case-insensitive substring match on task key + title and wiki title +
  slug. Archived tasks are excluded (task-link search precedent). Tasks
  come first; ~8 results total (wiki fills the remainder after tasks).
  milestones / swimlanes / columns match on name + derived slug and each
  carry their own cap of 8 results (so an exact entity match is never
  squeezed out by task hits); archived milestones and swimlanes are
  excluded. These three have no `slug` column — `slug` is the derived
  mention token and `sublabel` is the popup's one-line hint.
  Empty q → empty arrays (no unbounded listing).
  | 404 PROJECT_ACCESS_DENIED
```

Mention model (user-ruled split):
- **TipTap documents** carry mention NODES `{ type: "mention", attrs: { refType: "task"|"wiki", refId, label } }` — links only, never context injection. Pushed to GitHub as absolute deep links (`${PUBLIC_URL}/{slug}/tasks?task={id}` / `${PUBLIC_URL}/{slug}/wiki/{slug}`) with the label as link text.
- **Assistant chat** uses plain `@token` strings in the textarea; the server resolves them at send into ephemeral context (see the chat/stream contract above).

### Task Links (subtasks, blocked-by, related)
```
GET    /api/projects/:slug/tasks/:id/links
→ 200 { data: TaskLink[] }        // all relations involving the task

POST   /api/projects/:slug/tasks/:id/links
body { toTaskId*, relation*: "subtask_of"|"blocked_by"|"related_to" }
  toTaskId accepts the ticket key (PREFIX-N) alias
→ 201 TaskLink
  | 404 TASK_NOT_FOUND
  | 409 TASK_LINK_CYCLE            // subtask_of would create a cycle
  | 422 INVALID_TASK_LINK          // self-link, cross-project

DELETE /api/projects/:slug/tasks/:id/links/:linkId
→ 204 | 404 TASK_LINK_NOT_FOUND

GET    /api/projects/:slug/tasks/search?q&exclude
→ 200 { data: TaskLinkSuggestion[] }   // @-autocomplete; title LIKE, cap 10
  exclude = task id to skip (the current task); accepts the ticket key
  (PREFIX-N) alias too — an unresolvable key is ignored (no exclusions)
  When q matches the PREFIX-N ticket-key pattern, the exact key match is
  surfaced first (server pre-checks the same way the UI does)
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
→ 200 WikiPage | 404 | 409 SLUG_TAKEN | 422 INVALID_PARENT
  parentId must be null, the page's own current parent, or a page in the same
  project that is not a descendant (self / cross-project / cycle → INVALID_PARENT,
  details: { reason }).

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

POST   /api/projects/:slug/wiki/pages/:pageSlug/share
body { expiresAt? }              (UTC ISO-8601; {} or omitted = never expires)
→ 201 { link: { id, url, expiresAt, createdAt } } | 404 PAGE_NOT_FOUND | 403 PROJECT_ACCESS_DENIED
  url = `${PUBLIC_URL}/share/${token}` — the token itself is NEVER returned
  after create (capability: only the URL carries it).

GET    /api/projects/:slug/wiki/pages/:pageSlug/share
→ 200 { data: [{ id, url, expiresAt, createdAt }] } | 404 PAGE_NOT_FOUND | 403 PROJECT_ACCESS_DENIED

DELETE /api/projects/:slug/wiki/share/:linkId
→ 204 | 404 SHARE_LINK_NOT_FOUND | 403 PROJECT_ACCESS_DENIED
  Revocation = row deletion; the link stops resolving immediately.
```

### Wiki share — public

```
GET    /api/share/:token          (PUBLIC — no auth; dedicated stricter rate-limit bucket)
→ 200 { root: { id, title, slug, content: TipTapDoc, updatedAt,
                children: [ <same shape, recursive> ] } }
  One request returns the root page plus its FULL descendant subtree,
  resolved at request time (later page edits are visible through the same
  link; navigation is limited to the subtree).
| 404 SHARE_LINK_NOT_FOUND    (missing == expired == revoked — identical envelope)
| 429                         (bucket exhaustion)

GET    /api/share/:token/attachments/:id   (PUBLIC — same bucket + rules)
→ 200 binary (same sniffed-mime / disposition / nosniff rules as
   GET /api/attachments/:id)
| 404 SHARE_LINK_NOT_FOUND    (token missing/expired/revoked — validated per request;
                               revoking the link kills attachment access immediately)
| 404 ATTACHMENT_NOT_FOUND    (unknown id, or attachment not in the shared subtree)
  Only wiki-page attachments whose page lies inside the shared subtree are
  reachable; task attachments are never exposed through share links.
```

### Settings

```
GET    /api/settings/api-keys  (admin)
→ 200 { data: ApiKey[] }
  Keys include owner info (ownerEmail/ownerName — null = server key).

POST   /api/settings/api-keys  (admin, session user required)
body { name* }
→ 201 { key: ApiKey, rawKey: "lxk_..." }
  ⚠ rawKey returned ONCE — never stored, never shown again
  The key binds to the creating user (identity.userId required — a bare
  server key cannot mint another key; 403 FORBIDDEN otherwise). Server keys
  (`user_id NULL`) are legacy rows from pre-change installs; never created
  through the API.

DELETE /api/settings/api-keys/:id  (admin)
→ 204 | 404
```

### Personal API keys (self-service — any signed-in user)

```
GET    /api/me/api-keys  (session or user-bound key)
→ 200 { data: ApiKey[] }   own keys only

POST   /api/me/api-keys  (session or user-bound key)
body { name* }
→ 201 { key: ApiKey, rawKey: "lxk_..." }  (rawKey once)
  Binds to the caller (userId required; bare server keys → 403 NO_USER_CONTEXT)

DELETE /api/me/api-keys/:id  (owner only)
→ 204 | 404   (non-owner → 404 — no existence oracle)

GET    /api/settings/api-keys remains the admin view of ALL keys (incl. owner
       column + server-key tag).
```

### Device login (CLI pairing)

Machine-to-machine login without a pre-shared key. Flow: CLI POSTs a request
→ prints the verify URL → a logged-in user approves in the browser → the
CLI's poll receives a freshly minted **user-bound** API key once. The single
`token` (256-bit, hex-encoded) is both the poll credential and the approve
capability; approval additionally requires a session. Both endpoints are
API-key exempt but rate-limited (create: general bucket; the short `code` is
display-only — no oracle, brute force is infeasible against a 256-bit token).

```
POST   /api/device-login/requests  (key-exempt, rate-limited)
body { clientName*: string }              — "cli-<hostname>"
→ 201 { id, code: "ABCDEFGH", verifyUrl: "<base>/device-login?request=<id>&token=t…", expiresMs }
  verifyUrl built from LXK_PUBLIC_URL; carries the request id + one-time
  token (the approve page needs both); valid 10 minutes.
  | 429 RATE_LIMITED

GET    /api/device-login/requests/:id  (key-exempt; header x-device-token)
→ 200 { status: "pending", clientName, code, expiresAt }
     — keep polling (~2s interval); clientName/code/expiresAt power the
       browser approve page (same endpoint, no separate fetch)
→ 200 { status: "approved", rawKey: "lxk_...", keyName, approverName? }
     rawKey returned ONCE — the first poll after approval atomically consumes
     the row (DELETE … RETURNING), then mints the user-bound key (owner =
     approver, name = clientName). Consume and INSERT are two statements: if
     the insert fails the request is spent and the client re-runs `lx login`.
     A second poll → 404 DEVICE_LOGIN_NOT_FOUND. Minting on the poll (not on
     approve) is what makes the flow isolate-independent — no shared
     in-memory transit state.
→ 403 { error: { code: "DEVICE_LOGIN_DENIED" } }
→ 410 { error: { code: "DEVICE_LOGIN_EXPIRED" } }
→ 404 { error: { code: "DEVICE_LOGIN_NOT_FOUND" } }    (unknown id / consumed)

POST   /api/device-login/requests/:id/approve  (user-bound identity + token)
body { token*: string }        — token is the raw hex string from the URL
→ 200 { status: "approved", clientName }
  Flips the request to approved and records the approver (single conditional
  UPDATE). The key is NOT minted here — the CLI's first subsequent poll
  consumes the row and mints the user-bound key (user_id = approver, name =
  clientName), which then appears in the approver's Settings → Me → API keys.
  Any user-bound identity may approve (session cookie or a user-bound key —
  the token, a 256-bit capability, is the approval secret); bare server keys
  → 401/403.
  | 401 (no identity) | 404 DEVICE_LOGIN_NOT_FOUND (unknown/mismatched/
    consumed — no oracle) | 410 DEVICE_LOGIN_EXPIRED
```

Errors: `DEVICE_LOGIN_NOT_FOUND` (404), `DEVICE_LOGIN_EXPIRED` (410),
`DEVICE_LOGIN_DENIED` (403), `NO_USER_CONTEXT` (403, personal keys +
mint-from-server-key paths).

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
→ 200 { appId: string, appSlug: string, privateKeySet: boolean,
        webhookSecretSet: boolean, source: "settings" | "none" }
  Effective GitHub App config. The DB is the single source of truth:
  settings.github_app_id / settings.github_app_slug (plaintext identifiers) plus
  the encrypted github_app_secrets rows for the PEM and webhook secret. Legacy
  plaintext settings.github_private_key / settings.github_webhook_secret rows
  stay READABLE as a fallback for installs written before the encrypted store
  existed (an encrypted row, when present, is authoritative — if it cannot be
  opened, the value reads as unset rather than falling back). Env (GITHUB_APP_ID
  / GITHUB_PRIVATE_KEY / GITHUB_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET) is a
  first-boot bootstrap, mirrored into the DB once at boot. source = "settings"
  if the app id or either credential is set, else "none" (no "env" state — env
  is never a runtime source; a slug alone does not flip source).
  ⚠ Write-only secrets: the PEM and webhook secret are never returned —
  only privateKeySet / webhookSecretSet booleans.

PUT    /api/settings/github  (admin)
body { appId*: string (digits, e.g. "1234567"), appSlug?: string,
       privateKey?: string (PEM text), webhookSecret?: string }
→ 200 same shape as GET
  | 422 INVALID_GITHUB_SETTINGS (missing/invalid appId, privateKey not a PEM)
  Present field = replace; empty string = CLEAR (deletes the settings row);
  omitted field = unchanged. Secrets are written PLAINTEXT to the legacy settings
  rows and the matching encrypted github_app_secrets row is deleted — a manual
  PUT is the last explicit write and always wins. Applies live (holder + cache
  reset — no restart); webhook verification picks up the new secret immediately.

POST   /api/settings/github/manifest  (admin)
→ 200 { url: string, state: string, manifest: GithubAppManifest }
  Starts the in-app "Connect GitHub App" flow. `url` is the GitHub App-creation
  form target with the single-use `state` on the query string; POST `manifest` to
  it as a form field (GitHub creates the App, then redirects to
  /settings/github/callback). `state` lives in settings.github_manifest_state,
  is single-use, and expires after 10 minutes. The manifest asks for
  issues:write, metadata:read, contents:read and the `issues` event; hook +
  redirect URLs derive from LXK_PUBLIC_URL (resolvePublicUrl).

POST   /api/settings/github/setup  (admin)
body { code?: string, state*: string }
→ 200 same shape as GET
  | 400 GITHUB_MANIFEST_STATE_INVALID
  | 422 GITHUB_MANIFEST_PERMISSIONS_DENIED
  | 500 GITHUB_SECRET_WRITE_FAILED
  | 502 GITHUB_MANIFEST_EXCHANGE_FAILED
  Completes the flow: consumes `state` (always — match or not), exchanges `code`
  for the App credentials against GitHub, asserts the reported permissions, then
  writes the app id + slug plaintext and both secrets encrypted
  (github_app_secrets; legacy plaintext rows deleted). Applies live. A cancelled
  consent (no `code`) still consumes the state and writes nothing, returning the
  current summary.
  ⚠ Reconnect: this path REPLACES an existing App's credentials; the previous
  webhook secret is dropped, so the old App's deliveries stop verifying.

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
  Cascades: memberships. Projects block at the service guard.

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

POST   /api/auth/invite/peek    (keyless, session-less — the token is the auth)
body { token* }
→ 200 { valid: true, email } | 200 { valid: false, reason }
  reason ∈ "used" | "expired" | "unknown". Non-consuming pre-flight for the
  /invite page: missing row → `unknown`, accepted_at set → `used`, past
  expires_at → `expired`; the email is returned only when valid. Same guards
  as accept (whose single `INVALID_TOKEN` is unchanged) — peek only decides
  the page's render state, it never consumes the invite.

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


### Document sources + Agents & Skills catalog

```
# ── Document sources (assistant grounding; browser, Bearer) ──
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

# ── Lexa Agents & Skills catalog (global rule bundles; browser, Bearer) ──
# Hard cutover from the pre-baseline agent/skill paths — no aliases (sole
# consumer is the bundled web app). The catalog is the behavioral spec for the
# in-process Assistant (prompt injection); the removed Blacksmith/daemon
# file-writing consumer no longer exists. All mutations are admin-only
# (403 FORBIDDEN for members).
GET    /api/agents
→ 200 { data: LexaAgent[] }   (agent = { id, name, description, instructions,
  isBuiltin, skillIds[], createdAt, updatedAt })

POST   /api/agents        (admin)  body { name*, description?, instructions* }
→ 201 LexaAgent  | 403 FORBIDDEN | 409 CONSTRAINT (duplicate name)

PATCH  /api/agents/:id    (admin)  body { name?, description?, instructions? }
→ 200 LexaAgent  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 409 CONSTRAINT

DELETE /api/agents/:id    (admin)
→ 204 | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 422 AGENT_BUILTIN_DELETE | 409 AGENT_ENTITY_IN_USE
  (builtins can't be deleted; an agent still used by assistant tasks can't either)

PUT    /api/agents/:id/skills  (admin)  body { skillIds*: string[] }  (full replace)
→ 200 LexaAgent  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND / SKILL_NOT_FOUND
  (M2M bindings; the assistant skill picker only offers the attached skills)

POST   /api/agents/:id/reset  (admin; builtin only)
→ 200 LexaAgent  (restores the seeded instructions + full builtin skill set)
  | 403 FORBIDDEN | 404 AGENT_NOT_FOUND | 422 AGENT_BUILTIN_DELETE

GET    /api/skills
→ 200 { data: LexaSkill[] }   (skill = { id, name, description, instructions, isBuiltin, createdAt, updatedAt })

POST   /api/skills        (admin)  body { name*, description?, instructions* }
→ 201 LexaSkill  | 403 FORBIDDEN | 409 CONSTRAINT

PATCH  /api/skills/:id    (admin)  body { name?, description?, instructions? }
→ 200 LexaSkill  | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 409 CONSTRAINT

DELETE /api/skills/:id    (admin)
→ 204 | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 422 AGENT_BUILTIN_DELETE | 409 AGENT_ENTITY_IN_USE

POST   /api/skills/:id/reset  (admin; builtin only)
→ 200 LexaSkill  | 403 FORBIDDEN | 404 SKILL_NOT_FOUND | 422 AGENT_BUILTIN_DELETE
```

Notes:
- **SSRF guard:** external sources resolve DNS and reject private/loopback/
  link-local/CGNAT addresses before fetching.
- **Assistant grounding:** repo content (Contents: Read) is fetched server-side
  per assistant run from the project's `source_role` repos, capped by
  `assistant_repo_cap` (env bootstrap `LXK_ASSISTANT_REPO_CAP`, default 3).

### Assistant (AI assistant tier)

Server-side TanStack AI `chat()` assistant (in-process; the external
Blacksmith/daemon tier was removed). Per-project provider settings;
keys are server-side only and never serialized (masked view). Settings
mutations + test/models are superadmin (`403 FORBIDDEN` otherwise); reads,
tasks, chat, and memory follow normal project access; chat additionally
requires a session user (bare API key → `400 NO_USER_CONTEXT`).

Visibility: Assistant task brief info (status, timestamps) is member-visible;
the result text is admin-gated on the status endpoint.

```
GET    /api/assistant/settings/:projectId
→ 200 { projectId, searchProvider: "exa"|null, hasSearchKey: boolean,
        urlAllowlist: string|null,
        reasoningEffort: "minimal"|"low"|"medium"|"high"|null,
        primarySupportsImages: boolean,
        writeTools: string[],
        providerId: string|null, modelId: string|null,
        fallbackModelIds: string[] }
  Masked view — no provider api_key/search_api_key ever serialized. Provider
  binding (providerId/modelId/fallbackModelIds) comes from the global gateway
  registry (GET /api/admin/assistant/providers). Legacy per-project provider
  columns (kind/base_url/api_key/model/vision_model) were dropped in the squashed baseline.
  | 404 PROJECT_NOT_FOUND | 404 ASSISTANT_THREAD_NOT_FOUND | 409 PROVIDER_NOT_CONFIGURED (no row yet)

PUT    /api/assistant/settings/:projectId   (superadmin — requireSuperadmin, 403 FORBIDDEN otherwise)
body { providerId?: string|null, modelId?: string|null, fallbackModelIds?: string[],
       searchProvider?: "exa"|null, searchApiKey?: string|null,
       urlAllowlist?: string|null,
       reasoningEffort?: "minimal"|"low"|"medium"|"high"|null,
       writeTools?: string[] }
  Payload is the project-level Assistant binding + search/writeTools.
  (engine/engineSwitcherEnabled were removed with the runtime tier.)
  providerId/modelId = primary model (must be an enabled assistant_models row);
  fallbackModelIds = ordered cross-kind fallback list (≤3, deduped, provider
  registry supplies kind per model). Omitted searchApiKey keeps the stored value.
  After the squashed baseline kind/base_url/api_key/model/vision_model are gone from
  assistant_settings — provider credentials live in assistant_providers only.
  writeTools: unknown names dropped, duplicates collapse, stored comma-separated.
→ 200 masked view (same shape as GET) | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND

POST   /api/assistant/settings/:projectId/test   (admin — requireAdmin)
body { kind?, baseUrl?, model?, apiKey?, searchProvider?, searchApiKey?,
       urlAllowlist?, primarySupportsImages?,
       visionModel?, reasoningEffort?, writeTools? }
  UNSAVED submitted values (never persists); an omitted apiKey falls back to the
  stored one so testing a saved config doesn't require re-entering the key.
  After the squashed baseline the payload is legacy-compatible (kind/baseUrl/model optional) and
  the gateway fallback is used when they are omitted.
→ 200 { ok: true, latencyMs } | 502 PROVIDER_AUTH_FAILED | 502 PROVIDER_UNREACHABLE
  Minimal completion ping (+ Exa ping when configured).

POST   /api/assistant/settings/:projectId/models   (admin — requireAdmin)
body same as test
→ 200 { models: [{ id }] } | 502 PROVIDER_AUTH_FAILED / PROVIDER_UNREACHABLE
  Lists models from the provider using submitted unsaved values (per-kind wire
  format, base URL normalized per kind). Some compat endpoints lack the route
  — manual model entry is always available as fallback.

### Assistant Gateway — Admin Registry (superadmin-only, requireSuperadmin → 403 FORBIDDEN otherwise)

Global provider registry. `assistant_providers` holds the label/base URL;
`assistant_models` holds per-model kind/priority/enabled; `assistant_call_logs` is
append-only; `assistant_model_prices` is the OpenRouter price cache. Gateway
streams with cross-kind fallback (≤3, priority-ordered), fresh adapter per
attempt, cost via `assistant_model_prices` (OpenRouter fetch).

Provider API keys are **managed secrets**, not columns: a key is entered here,
stored AES-256-GCM encrypted in `assistant_provider_secrets` (scope `provider`,
AAD-bound to the provider id), and never serialized. Responses expose `hasKey`
and `keyMask` and never a value; `apiKey` is **write-only by construction** (it
exists on the request schemas and not on the response shape). The legacy
`assistant_providers.api_key` column is **dead** in this release (writes `''`;
only the one-way boot backfill reads it) and is dropped in the next release.
Storing a key needs `LXK_SECRETS_MASTER_KEY`; without it the save is refused with
400 `SECRET_KEY_UNAVAILABLE` and stores nothing (a keyless provider stays legal).

```
GET    /api/admin/assistant/providers   (superadmin)
→ 200 { data: AssistantProviderMasked[], secretsEnabled: boolean }
  AssistantProviderMasked = { id, label, baseUrl, hasKey, keyMask, createdAt, updatedAt }
  | 403 FORBIDDEN
  `secretsEnabled` is additive and read-only: `true` when an
  `LXK_SECRETS_MASTER_KEY` is configured (a malformed one still reports `true`,
  so the save path's 400 names the required shape). Clients
  gate the key UI on it; it never exposes the key or any ciphertext.

POST   /api/admin/assistant/providers   (superadmin)
body { label*, baseUrl*, apiKey* }   // baseUrl = provider base URL, apiKey = provider secret
  An **empty** `apiKey` string registers a keyless provider (the field is
  required and must be present). Supplying one encrypts
  it; without a master key → 400 SECRET_KEY_UNAVAILABLE and nothing is created.
→ 200 AssistantProviderMasked (masked view of the created row)
  | 400 SECRET_KEY_UNAVAILABLE | 403 FORBIDDEN

PATCH  /api/admin/assistant/providers/:id   (superadmin)
body { label?, baseUrl?, apiKey?, clearKey? }   // patch — omitted fields unchanged; updated_at = datetime('now')
  Secret intent is read from the REQUEST only: an omitted or empty `apiKey`
  means **keep** the stored key (an empty string never clears anything), and
  `clearKey: true` is the only removal route — it deletes the ciphertext row,
  works even with no master key configured, and is refused when combined with a
  non-empty `apiKey`. A non-empty `apiKey` replaces the stored key and needs the master key.
→ 200 AssistantProviderMasked
  | 400 SECRET_KEY_UNAVAILABLE (unset or malformed master key on a key write)
  | 422 INVALID_ARGS (clearKey + non-empty apiKey in the same request)
  | 403 FORBIDDEN | 404 (RowNotFound → NOT_FOUND)

DELETE /api/admin/assistant/providers/:id   (superadmin)
→ 204 | 403 FORBIDDEN | 404 | 409 HAS_CHILDREN (models still referenced by a project's fallback set)

POST   /api/admin/assistant/providers/:id/test   (superadmin)
→ 200 { ok: true, latencyMs: number } | 403 FORBIDDEN | 404
  | 502 PROVIDER_AUTH_FAILED | 502 PROVIDER_UNREACHABLE
  Live probe: listModels against the stored provider row (kind openai_compatible, model "test").
  A stored key that cannot be opened with the configured master key is a hard
  502 PROVIDER_AUTH_FAILED with the fixed message
  `stored provider key could not be decrypted with the configured master key — re-enter the key`
  (never a silent empty credential).

POST   /api/admin/assistant/providers/:id/models   (superadmin)
→ 200 { data: AssistantModelRow[] }   AssistantModelRow = { id, providerId, modelId, kind, priority, enabled, createdAt }
  | 403 FORBIDDEN | 404

PATCH  /api/admin/assistant/providers/:id/models/:modelId   (superadmin)
body { enabled?: boolean, priority?: number }
→ 200 AssistantModelRow (updated model; fields omitted are unchanged)
  | 403 FORBIDDEN | 404 (provider or model not found)

POST   /api/admin/assistant/providers/:id/models/reorder   (superadmin)
body { orderedIds: string[] }
→ 200 { data: AssistantModelRow[] }   // all provider models, reordered by priority
  | 403 FORBIDDEN | 404 (provider/model set not found or orderedIds does not exactly match)

GET    /api/admin/assistant/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&projectId=ID   (superadmin)
→ 200 { summary: { totalTokens, promptTokens, completionTokens, totalCostCents, totalCostUsd, avgLatencyMs: number|null, p50LatencyMs: number|null, p95LatencyMs: number|null, errorRate: 0-1, totalCalls, errorCalls }, byDay: Array<{ day: YYYY-MM-DD, tokens, costCents, costUsd, avgLatencyMs, calls, errorRate }>, byModel: Array<{ model, tokens, costCents, costUsd, avgLatencyMs, calls, errorRate }>, totalCostCents }
  | 403 FORBIDDEN
  Filters: from/to are date( created_at ) inclusive bounds; projectId scopes to one project (also available as GET /api/projects/:slug/assistant/usage?from=&to= — same shape, superadmin, slug resolved to projectId). Unbounded when omitted. Aggregation via assistant_call_logs indexes idx_call_logs_project_time / idx_call_logs_model.

GET    /api/admin/assistant/usage.csv?from=&to=&projectId=   (superadmin)
→ 200 text/csv; header day,model,tokens,cost_cents,cost_usd,avg_latency_ms,calls,error_rate; rows grouped by (day, model) ordered day ASC; same auth + filters as the JSON endpoint. Content-Disposition: attachment; filename="assistant-usage.csv"

GET    /api/admin/assistant/prices   (superadmin)
→ 200 { data: [{ model, prompt_price, completion_price, cached_read_price, cached_write_price, updated_at }] }   // all prices USD per 1M tokens
  | 403 FORBIDDEN

PUT    /api/admin/assistant/prices   (superadmin)
body { model*, prompt_price*, completion_price*, cached_read_price*, cached_write_price* }   // USD per 1M tokens, numbers >=0, max 6 decimals
→ 200 { model, prompt_price, completion_price, cached_read_price, cached_write_price, updated_at } | 403 FORBIDDEN | 422 INVALID_ARGS
  Writes to assistant_model_prices (ON CONFLICT upsert, updated_at = datetime('now')).

GET    /api/projects/:slug/assistant/usage?from=&to=   (superadmin)
→ 200 same shape as GET /api/admin/assistant/usage scoped to that project | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND

GET    /api/admin/assistant/calls   (superadmin)
→ 200 { data: AssistantCallLogRow[] }   // last 100, created_at DESC
  | 403 FORBIDDEN

### Assistant MCP clients

The assistant can consume external MCP (Model Context Protocol) servers. Every
registry row is a **client** — a connection from Lexa to a remote MCP server —
never a server hosted by Lexa. The registry mirrors the provider registry:
`assistant_mcp_servers` is global (superadmin CRUD),
`assistant_mcp_project_servers` is per-project availability (absence =
unavailable). Only read-only-annotated tools are exposed to the model
(`buildMcpTools` per stream; `mcp__<serverId>__<tool>`, default-deny,
fail-open discovery). The **managed token** is the only credential source:
`secret` (entered here, stored AES-256-GCM encrypted in
`assistant_mcp_secrets`) when a master key is configured, or no credential at
all (a deliberately secret-less client). A credential is never serialized:
responses expose `hasSecret` plus `secretSource` and never a value. The
historical `env:NAME` / `file:/abs/path` reference source was removed
(2026-09-28) — see the Legacy notes below.

Writes accept **HTTP and SSE only**: Lexa spawns no local process, so `stdio` is
rejected on every runtime (Bun host included) with
`MCP_INVALID_TRANSPORT_CONFIG`. The request and response schema still carries
the historical `http` | `sse` | `stdio` literal, so a legacy stdio payload
reaches the service and gets that exact domain error instead of a generic
schema-decode 400. Migration `0010_remove_stdio_mcp_clients.sql` deletes every
stored `transport_type='stdio'` row and its project bindings; the registry
starts empty and no Jev client is seeded. The physical `command`/`args` columns
and the `stdio` branch of the 0009 CHECK are retained untouched because D1
cannot drop columns or rewrite a CHECK without a table rebuild — they are legacy
shape, not supported input.

```
McpServer = { id, label, transportType, url: string|null, command: string|null,
              args: string[], hasSecret: boolean,
              secretSource: "managed"|"none", enabled: boolean,
              createdAt, updatedAt }
  // breaking: the historical `"reference"` value is gone; a stored ref now
  // reads as `"none"` (value cleared by migration 0012).

GET    /api/assistant/mcp-servers   (superadmin)
→ 200 { data: McpServer[], managedSecretsEnabled: boolean }   // every registered remote client; empty until one is created
  | 403 FORBIDDEN
  `managedSecretsEnabled` is additive and read-only: `true` when the server holds
  a usable `LXK_SECRETS_MASTER_KEY`, so a client can store a managed token. Clients
  gate the managed-token UI on it — an absent key disables the option and any
  managed save is refused with MCP_INVALID_TRANSPORT_CONFIG. It never exposes the
  key or any ciphertext.

POST   /api/assistant/mcp-servers   (superadmin)
body { label*, transportType*, url?, command?, args?, secretRef?, secret?, enabled? }
  id is derived from the label (slug) and is an ordinary identifier — no id is
  reserved. http/sse require `url` (http/https, no userinfo);
  `transportType: "stdio"` → 400 MCP_INVALID_TRANSPORT_CONFIG. A `command` or a
  non-empty `args` in an http/sse payload is REJECTED (400
  MCP_INVALID_TRANSPORT_CONFIG) — never silently dropped. `secret` is the
  managed Bearer token: write-only, non-empty, at most 4096 characters; omitted
  (or empty) stores a secret-less client. `secretRef` is deprecated and
  accepted-and-ignored — a non-empty value emits one structured `WARN` on stderr
  and has no effect on the created row (an older client's payload still decodes
  rather than 400ing). Storing a token requires `LXK_SECRETS_MASTER_KEY`; without it
  the save is refused with 400 MCP_INVALID_TRANSPORT_CONFIG and nothing is
  stored, while a secret-less client is still legal.
→ 201 McpServer | 400 MCP_INVALID_TRANSPORT_CONFIG | 404 MCP_SERVER_NOT_FOUND
  | 403 FORBIDDEN

PATCH  /api/assistant/mcp-servers/:id   (superadmin)
body { label?, transportType?, url?, command?, args?, secretRef?, secret?,
       clearSecret?, enabled? }
  Omitted fields unchanged; the merged row is re-validated, so switching
  transport requires the matching field in the same request. `stdio` → 400
  MCP_INVALID_TRANSPORT_CONFIG, as are a supplied `command`/`args`. Secret intent
  is read from the REQUEST only: an omitted or empty `secret` means **keep** the
  stored token (an empty string never clears anything), and `clearSecret: true`
  is the only removal route — it deletes the ciphertext row, works even with no
  master key configured, and is refused (400 MCP_INVALID_TRANSPORT_CONFIG) when
  combined with a `secret`. `secretRef` here is deprecated and
  accepted-and-ignored exactly as on create (one `WARN`, no effect). Every write
  also nulls the legacy `secret_ref` column.
→ 200 McpServer | 400 MCP_INVALID_TRANSPORT_CONFIG | 403 FORBIDDEN
  | 404 MCP_SERVER_NOT_FOUND

DELETE /api/assistant/mcp-servers/:id   (superadmin)
→ 204 | 403 FORBIDDEN | 404 MCP_SERVER_NOT_FOUND

POST   /api/assistant/mcp-servers/:id/test   (superadmin)
→ 200 { ok, toolCount, readOnlyToolCount, latencyMs, error: { code, message }|null }
  Always 200 when the row exists — a failed connect is a result, not a server
  error; 404 MCP_SERVER_NOT_FOUND only for an unknown id. `code` is
  MCP_CONNECT_FAILED on a failed connect, and MCP_INVALID_TRANSPORT_CONFIG for a
  legacy stdio row (0010 removes those, so it is only reachable on a database
  that predates it). MCP_TOOL_CALL_FAILED is a tool-loop code and never appears
  here. MCP_STDIO_UNAVAILABLE stays reserved in the error catalog and is never
  emitted; it is retained only so a client that still decodes the code keeps
  parsing responses on the wire.

GET    /api/projects/:id/assistant/mcp-servers   (project member — requireProjectReadById)
→ 200 { data: [{ projectId, serverId, enabled, createdAt, updatedAt }] }
  | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND

PUT    /api/projects/:id/assistant/mcp-servers   (project admin — requireProjectAdminById)
body { entries: [{ serverId*, enabled* }] }
  Replace-set: the project's availability is exactly `entries`. An unknown
  serverId → 404 MCP_SERVER_NOT_FOUND.
→ 200 { data: [...] } (same shape as the GET) | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND
```

Notes:
- **SSRF:** http/sse registrations pass the SSRF guard at save time and again
  at connect time; the project `url_allowlist` applies at connect.
- **Secrets:** the managed token is the only credential source, and every route
  here is superadmin-only. It is never serialized, echoed, or logged — responses
  expose `hasSecret` and `secretSource` only, and `secret` is **write-only by
  construction** (it exists on the request schema and not on the response schema,
  so no response can carry a value).
  - `secret` is a managed Bearer token, stored AES-256-GCM encrypted in
    `assistant_mcp_secrets` (migration `0011_mcp_managed_secrets.sql`); the
    master key lives only in the environment (`LXK_SECRETS_MASTER_KEY`, with
    `LXK_SECRETS_MASTER_KEY_PREV` as the rotation read path). Plaintext exists only
    in the request and in the encrypt call — never in a registry row, a log line,
    or a response. At connect it becomes the single header
    `Authorization: Bearer <secret>`; a genuinely secret-less client sends no
    authorization header at all.
  - **`secretSource` is `"managed"` or `"none"`** — `hasSecret` is true exactly
    when a managed token is stored. The historical `"reference"` value is gone:
    this is a **breaking response-value change**, so a client still decoding
    `"reference"` must accept `"none"` instead (older rows that carried a ref are
    cleared by migration `0012`).
  - **No reference source.** The `env:NAME` / `file:/abs/path` resolution path
    (`server/env.ts` `resolveSecretRef`), the fixed-`RuntimeEnv` allowlist check,
    and the master-key denylist were removed on 2026-09-28. `secretRef` survives
    only as a deprecated accepted-and-ignored field (see the POST/PATCH bodies
    above); a legacy stored `secret_ref` is dead and hard-fails at connect until
    a write clears it (see Legacy below).
  - **Clear:** `clearSecret: true` on the PATCH is the **only** removal route —
    there is no null-both form, no sentinel string, and no empty-value overload
    ("empty means keep" is exactly why clear needs its own flag). It is a pure
    row delete, so it works with **no master key configured** — a credential can
    always be revoked, including on a deployment whose key is gone.
  - **Required to store, disabled without it:** when `LXK_SECRETS_MASTER_KEY` is
    unset, a save carrying `secret` is refused with 400
    `MCP_INVALID_TRANSPORT_CONFIG` and stores nothing; a secret-less client is
    still legal, and a client that already has a stored token keeps
    `hasSecret: true` — a missing key never silently drops a secret.
  - A managed token containing CR, LF or NUL cannot become a header value; the
    connect is refused with `MCP_CONNECT_FAILED` and a fixed message that never
    echoes the value. A failed connect reports a fixed generic message — remote
    error text (SDK, transport, or MCP server response) is never echoed into
    `error.message` or the server logs.
  - **Every credential failure is a hard 502 `MCP_CONNECT_FAILED`**, never a
    silent anonymous connect: a legacy stored `secret_ref`, a wrong key, a
    tampered blob, a `key_id` Lexa does not recognize, or a managed row on a
    deployment with no key all report `MCP_CONNECT_FAILED` with one fixed message
    (the ref itself is never echoed). That hard failure is the **test route**; on
    the **assistant run** the same refusal is fail-open bridge behavior — the
    server is skipped with a `WARN` line on stderr and its tools are simply
    unavailable for that run, while the rest of the session continues. Rotation is
    rewrap-free: `LXK_SECRETS_MASTER_KEY_PREV` keeps old rows readable, and
    re-encrypting a row means re-entering the token in the webapp.
- **Legacy compatibility:** a stored `secret_ref` is **dead** — a connect
  refuses it with `MCP_CONNECT_FAILED` (never an anonymous connect) until any
  write clears it; migration `0012_remove_mcp_secret_refs.sql` clears every
  stored ref at boot, and every repo write nulls the column. An **omitted or
  empty `secret` means keep**, so an older client that PATCHes `{ label }` never
  disturbs a managed token (the write also clears the legacy ref).
  `secretRef: null` is *not* a clear — it is an absent, ignored field (clearing
  is `clearSecret: true`). The `stdio` literal stays on the wire schema so a
  legacy payload still fails with the exact domain error, and `command: ""` (or
  whitespace) means "no command" — it normalizes to `null` rather than being
  refused; a **non-blank** `command` is still rejected.
- **Legacy columns:** `command` and `args` stay in the table and in the response
  shape for compatibility; clients created through the API always store
  `command = null` and `args = []`, and a payload that supplies either is
  rejected rather than stripped.

### Assistant Jev (superadmin config + per-project opt-in)

Typesafe Jev is a typed System 1 judgment API, not a chat provider and not an MCP
client. Its configuration lives in the DB registry, not in env:
`assistant_jev_config` (singleton base URL / model / enabled),
`assistant_jev_secrets` (the envelope-encrypted API key), and
`assistant_jev_projects` (per-project opt-in, absence = disabled). The API key is
**write-only by construction** — it exists on the PATCH payload and never on a
response — and responses expose `hasKey` / `keyMask` only.

```
GET    /api/assistant/jev   (superadmin → 403 FORBIDDEN otherwise)
→ 200 { config, secretsEnabled }
  AssistantJevMasked = { id: "default", baseUrl, model, enabled, hasKey,
                         keyMask: string|null, createdAt, updatedAt }
  | 403 FORBIDDEN
  `secretsEnabled` is additive and read-only: `true` when an
  `LXK_SECRETS_MASTER_KEY` is configured (a malformed one still reports `true`,
  so the save path's 400 names the required shape), which lets a Jev key be
  stored. It never exposes the key or any ciphertext.

PATCH  /api/assistant/jev   (superadmin)
body { baseUrl?, model?, enabled?, secret?, clearSecret? }
  `secret` is write-only, at most 4096 characters; an omitted or empty `secret`
  means **keep** (an empty string never clears anything), and `clearSecret: true`
  is the only removal route — a pure row delete that works with **no master key**
  configured, and is refused when combined with a non-empty `secret`. `baseUrl`
  must be an absolute http(s) URL with no userinfo;
  `model` is 1–120 characters.
→ 200 { config, secretsEnabled }
  | 400 JEV_INVALID_CONFIG (clearSecret + non-empty secret; invalid baseUrl; bad model)
  | 400 SECRET_KEY_UNAVAILABLE (a secret with unset or malformed master key)
  | 403 FORBIDDEN

POST   /api/assistant/jev/test   (superadmin)
→ 200 { ok: true, latencyMs: number, models: string[] }
  | 400 JEV_INVALID_CONFIG (no stored, openable key: "Jev is not configured — add an API key first")
  | 403 FORBIDDEN
  | 502 JEV_AUTH_FAILED (upstream 401/403) | 502 JEV_UNREACHABLE (network/timeout/5xx/unreadable)
  Probes the config before it is switched on: the enabled flags are ignored, but
  a stored, openable key is required. No API response body is echoed.

GET    /api/projects/:id/assistant/jev   (project member — requireProjectReadById)
→ 200 { projectId, enabled, available, createdAt: string|null, updatedAt: string|null }
  | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND
  `available` is additive: `true` when Jev is usable for projects at all (global
  config enabled AND a stored, openable key). It deliberately ignores this
  project's own row, so a member without superadmin read access can render the
  disabled toggle + "configure Jev" notice. Never key material. `enabled` is this
  project's opt-in; a project with no row reads `enabled: false` with null
  timestamps.

PUT    /api/projects/:id/assistant/jev   (project admin — requireProjectAdminById)
body { enabled: boolean }
→ 200 { projectId, enabled, available, createdAt, updatedAt }
  | 403 FORBIDDEN | 404 PROJECT_NOT_FOUND
```

Jev is advisory and fails open: an absent/undecryptable key makes per-run
resolution return `null`, so the preflight is simply not attempted and the
assistant run proceeds unchanged. Storing a key is refused with 400
`SECRET_KEY_UNAVAILABLE` when the master key is unset or malformed; clearing one
never needs it.

GET    /api/admin/assistant/runs?status=&projectId=&limit=&cursor=   (superadmin)
→ 200 { data: AssistantRunRow[], nextCursor: string|null,
        counts: { queued, running, completed, failed, cancelled } }
  AssistantRunRow = { id, key, projectId,
                      documentType: "task"|"wiki", documentId, documentTitle,
                      agentId, skillId, agentName, skillName,
                      status: "queued"|"running"|"completed"|"failed"|"cancelled",
                      error: string|null, createdAt, startedAt, finishedAt }
  Recent assistant runs (assistant_tasks), metadata only — `result`,
  `extraPrompt` and `selection` are never serialized; `error` is included.
  `error` is null unless status = failed.
  createdAt/startedAt/finishedAt are the raw assistant_tasks columns — SQLite
  UTC text ("YYYY-MM-DD HH:MM:SS" from datetime('now')), NOT JS ISO. Parse the
  space form as UTC, exactly like the assistant_calls timestamps.
  | 403 FORBIDDEN | 422 INVALID_ARGS
  Filters (all optional): `status` (one of the five statuses; unknown value →
  422), `projectId` (exact match, unfiltered when empty/omitted), `limit`
  (positive integer, default 50, capped at 200), `cursor` (opaque keyset token
  from the previous page's nextCursor; malformed token → 422).
  Keyset pagination on (created_at DESC, id DESC) — matches
  idx_assistant_tasks_created. `nextCursor` is "<createdAt>|<id>" of the last
  row, or null on the last page. The page is fetched with one extra row to
  decide nextCursor, so `data.length` may be `limit` on a full page.
  `counts` is the unfiltered GROUP BY over all statuses (assistant-task repo
  countByStatus) — always all five keys, zero-filled. It is a status tab total,
  not a total for the current filter or page.

GET    /api/admin/assistant/bindings   (superadmin)
→ 200 { data: [{ projectId, projectName, projectSlug,
                providerId: string|null, providerLabel: string|null,
                modelId: string|null, modelLabel: string|null,
                fallbackCount, writeToolsCount, memoryCount,
                hasSearchKey: boolean,
                reasoningEffort: "minimal"|"low"|"medium"|"high"|null,
                updatedAt: string|null }] }
  | 403 FORBIDDEN
  One row per project — the admin binding overview. Single query: projects
  LEFT JOIN assistant_settings / assistant_providers / assistant_models, so
  projects with no assistant_settings row are still listed (provider/model null
  = "not configured"). Labels are resolved server-side (no N+1).
  fallbackCount = json_array_length(fallback_model_ids) (0 when NULL);
  writeToolsCount = comma-separated entries in assistant_settings.write_tools
  (0 when NULL/empty); memoryCount = COUNT of project_memory rows for the
  project; hasSearchKey = search_api_key present (masked value never
  serialized); updatedAt = assistant_settings.updated_at, null when
  unconfigured. Ordered by project name (NOCASE) then projectId.

POST   /api/admin/assistant/prices/sync   (superadmin)
→ 200 { synced: number, data: [{ model, prompt_price, completion_price, cached_read_price, cached_write_price, updated_at }] }
  `synced` = rows upserted from the OpenRouter fetch into assistant_model_prices;
  `data` = the full refreshed price table (same row shape as GET .../prices) read
  after the upsert. The client applies `data` with setQueryData — no refetch
  needed (invariant #6).
  | 403 FORBIDDEN
  Errors inside the price fetch are caught — sync returns { synced: 0, data: <current rows> } rather than 5xx.

GET    /api/admin/assistant/providers/:id/health   (superadmin)
→ 200 { providerId: string, circuitState: "open"|"closed"|"half-open", failureCount: number, openedAt: string|null, lastProbeAt: string|null, consecutiveFailures: number,
        latencyMs: number|null, retryAfterSeconds: number|null, lastFailureCode: string|null, lastFailureAt: string|null, lastCheckedAt: string|null }
  | 403 FORBIDDEN | 404 (provider unknown → 404, missing health row → 200 default closed)
  Circuit breaker (pla-1): 3 consecutive fails in 5m → open 5m → half-open allow 1 probe (lazy, isAllowed handles transition).
  The breaker fields are persisted state; the four enriched fields are derived on
  every read from assistant_call_logs (the health row stores counts only) and are
  null when no signal exists:
    latencyMs          — latency of the most recent call with a recorded latency;
                         drives the "Slow" health state.
    retryAfterSeconds   — non-null only while circuitState = "open": whole seconds
                         until the 5m open window expires (max(0, …)); null for
                         closed/half-open. Drives the retry countdown.
    lastFailureCode     — error_code of the most recent error call (e.g.
                         PROVIDER_UNREACHABLE); null if the provider never failed.
    lastFailureAt       — created_at of that most recent error call; null if none.
                         NOTE the timestamp shape: breaker fields (openedAt,
                         lastProbeAt) and lastCheckedAt are JS ISO strings, but
                         lastFailureAt is the raw SQLite `created_at` value
                         ("YYYY-MM-DD HH:MM:SS" UTC) read straight from the call
                         log — parse it the same way lastCheckedAt's inputs are
                         parsed (treat the space form as UTC), do not assume ISO.
    lastCheckedAt       — the later of lastProbeAt (breaker probe) and the most
                         recent call-log time, normalized to ISO — i.e. when the
                         provider was last actually observed, not when a breaker
                         event happened. null when neither exists.
  A read that finds an open window already expired promotes the row to
  half-open (and stamps lastProbeAt) before responding.

POST   /api/admin/assistant/providers/:id/probe   (superadmin)
→ 200 same enriched health row shape as GET .../health (always 200 — upstream outcome is carried by the row, not the status)
  | 403 FORBIDDEN | 404 (provider unknown)
  Live probe: listModels against the stored provider row (same config as POST .../test), then recordSuccess (breaker closed, counts reset) or recordFailure (counts bumped, may re-open) before returning the row. Bypasses isAllowed — use after fixing the upstream.
```

POST   /api/assistant/tasks
body { slug*, documentType*: "task"|"wiki", documentId*, prompt*, agentId*,
       skillId*, selection?,
       attachments?: [{ storageKey*, mimeType*, name* }] }
  The assistant lane is the only lane; agentId is always the builtin `assistant`
  agent and skillId must be bound to it via lexa_agent_skills — else
  SKILL_NOT_FOUND. The task is appended to assistant_tasks as `queued`.
  attachments are image refs into the project's attachment storage
  (cross-project keys → 422); caps ≤5 images/message, ≤5MB each,
  png/jpeg/gif/webp only. Attachments require vision capability:
  primary_supports_images=1 → inline parts; else 409
  VISION_NOT_CONFIGURED (`vision_model` delegation removed in the squashed baseline).
→ 201 AssistantTask
  | 404 PROJECT_NOT_FOUND / TASK_NOT_FOUND / PAGE_NOT_FOUND / AGENT_NOT_FOUND / SKILL_NOT_FOUND
  | 409 PROVIDER_NOT_CONFIGURED          (no saved settings for the project)
  | 409 VISION_NOT_CONFIGURED            (attachments, no vision chain — vision_model removed in the squashed baseline)
  | 422 INVALID_ARGS                     (attachment scope/caps)

GET    /api/assistant/tasks/:id
→ 200 AssistantTask   (status/result/error + document title/agent/skill names)
  Poll for done/failed after a stream (the result text is included).
  | 404 ASSISTANT_TASK_NOT_FOUND

POST   /api/assistant/tasks/:id/stream      (SSE — POST + fetch-stream, not EventSource)
→ 200 text/event-stream
  Frames (exactly one terminal frame — error|done|suspended):
    event: start  data: {"taskId":"…","threadId":"…"}
    event: delta  data: {"text":"…"}
    event: tool   data: {"phase":"call"|"result","name":"…"}
    event: tool_pending data: {"approvalId":"…","batchId":"…","seq":n,
                               "name":"create_task","detail":"…",
                               "diff":{…AssistantWriteDiff…}}
    event: error  data: {"code":"ASSISTANT_GENERATION_FAILED","message":"…"}
    event: done   data: {"taskId":"…","text":"…","usage":{"in":n,"out":n}}
    event: suspended data: {"batchId":"…"}
    event: approval_result data: {"approvalId":"…","status":"applied"|"failed"|"denied",
                                 "error":"CODE: message"}          (resume streams only)
  tool_pending frames (one per pending write, seq order) appear only right
  before a terminal `suspended` frame — the turn proposed writes and awaits
  approval decisions; resume continues it (see resume endpoints below).
  approval_result frames (one per decided row of the resumed batch, seq
  order) appear right after the `start` frame on resume streams only:
  applied|failed for approved+executed rows (`error` carries "CODE: message"
  for failed rows), denied for rejected rows.
  Heartbeat comment ": ping" every 15s (proxy buffering). Client disconnect
  aborts the run (task → cancelled, "aborted" log). Stop button = client
  abort + cancel below.
  | 404 ASSISTANT_TASK_NOT_FOUND | 409 ASSISTANT_TASK_ACTIVE (already claimed/running)

POST   /api/assistant/tasks/:id/cancel
→ 200 { ok: true }
  Aborts an in-flight stream or cancels a queued task.

DELETE /api/assistant/threads/:documentType/:documentId
→ 204 | 404 ASSISTANT_THREAD_NOT_FOUND | 409 ASSISTANT_TASK_ACTIVE
  Resets the document thread — next run starts fresh.

POST   /api/assistant/chat/stream           (freeform chat — no queue row)
body { projectId*, chatId*, message*, agentId?,
       attachments?: [{ storageKey*, mimeType*, name* }],
       fromIndex?: number }
  Freeform chat ALWAYS runs the assistant lane (in-process).
  One persistent thread per (project, user), ownership enforced (another
  user's chatId → 404). Direct synchronous SSE — same frames as the task
  stream minus taskId (frames carry chatId). Second concurrent stream on the
  same chatId → 409 ASSISTANT_TASK_ACTIVE.
  attachments are chat-attachment refs (uploads above; cross-project keys →
  422). Images feed the vision path (inline parts; 409 VISION_NOT_CONFIGURED
  when `primary_supports_images=0`) and persist as `image-ref` parts; documents
  (PDF/Markdown/plain text) are extracted server-side (PDF via `unpdf`) and
  persist as `document-ref` parts, becoming model-visible text. Caps shared
  across images + documents: ≤3 per message, ≤5 MB each, ≤10 MB per message;
  the send is blocked with 422 ATTACHMENT_EXTRACTION_FAILED when a document
  yields no text, and with 403 CHAT_ATTACHMENTS_DISABLED under the kill switch.
  | 400 NO_USER_CONTEXT | 409 PROVIDER_NOT_CONFIGURED / ASSISTANT_TASK_ACTIVE
  | 409 VISION_NOT_CONFIGURED
  | 403 CHAT_ATTACHMENTS_DISABLED
  | 422 INVALID_ARGS / ATTACHMENT_EXTRACTION_FAILED

  Edit/regenerate/retry semantics (fromIndex):
  | fromIndex                    | effect
  |------------------------------|--------------------------------------------------
  | omitted or === messages.length | plain append — new turn after the transcript
  | < messages.length            | truncate transcript to fromIndex, then append
  |                                | `message` as the new turn (edit / regenerate /
  |                                | retry-after-error all reduce to this)
  Validation: integer, 0 ≤ N ≤ messages.length, else 422 INVALID_ARGS. The
  entry AT fromIndex (the one being replaced) must be a user-role message
  with string content — image-part entries are rejected in v1. Truncation
  happens BEFORE the new turn is generated; the thread title and pin survive.
  A failed turn persists as an assistant entry with an `error` meta block
  (catalog code); retrying means re-sending from the preceding user index,
  which drops the failed entry.

  Citations: when Assistant's web_search/fetch_url tools produce sources, the
  persisted assistant entry carries a `citations` meta list ({title, url},
  ≤10 per turn, URL-deduped, https-only) alongside the text.

  @-mention resolution (chat send contract): the plain-text message may
  contain `@KEY` (project task keys, case-insensitive) and `@slug` (project
  wiki slugs) tokens. The server resolves them AT SEND and injects the
  referenced content (task: key + title + description text; wiki page: title
  + content text) as an EPHEMERAL context block in the system prompts —
  NEVER into the persisted user message (the thread transcript stores the
  message verbatim; clients render chips from the raw tokens). Caps are
  enforced by silent truncation, never errors: ≤5 resolved mentions per
  message, ≤4000 chars of extracted text per referenced document,
  ≤20000 chars total context. Task-key grammar wins on ambiguity (a token
  that parses as a task key is never tried as a wiki slug); duplicate
  references to the same task/page resolve once; unknown tokens are ignored.

  $-skill resolution (chat send contract): the message may contain `$name`
  tokens (grammar: `$` followed by `[A-Za-z][A-Za-z0-9-]*`, so `$5`/`$PATH`
  never parse). Each token is normalized (lowercase, non-alphanumerics → `-`)
  and matched against the agent's junction-bound skills (`lexa_agent_skills`);
  a match injects that skill's instructions as an EPHEMERAL `## Skill: {name}`
  block in the system prompts for that request only — never into the persisted
  message. Order of appearance, ≤3 skills per message (the 4th+ stays literal
  text); an unbound/deleted token stays literal with nothing injected and no
  error. The run also carries the agent's bound-skill catalog; the model may
  read a skill in full with the read-only `get_skill` tool. Task/document run
  bodies are unchanged (they still bind `agentId` + `skillId`).

GET    /api/assistant/chat/:chatId
→ 200 { chatId, projectId, ownerUserId, agentId, skillId, messages, summary,
        summarizedCount, createdAt, updatedAt } | 404 ASSISTANT_THREAD_NOT_FOUND
  Transcript for reload/scrollback. Persisted entries carry optional meta:
  user entries a `ts` timestamp; assistant entries `ts`, `citations`, and on
  failure an `error` {code,message} block or a `stopped:true` marker (client
  abort with partial text).

DELETE /api/assistant/chat/:chatId
→ 204 | 404 ASSISTANT_THREAD_NOT_FOUND | 409 ASSISTANT_TASK_ACTIVE
  Deletes the chat thread outright ("Reset" on a multi-thread chat = delete
  current). 409 while a stream is in flight on that chatId; next "New chat"
  starts fresh.

POST   /api/assistant/approvals/:id/decide
body { verdict*: "approve" | "reject" }
→ 200 { approvalId, batchId, status, remaining }
  | 404 APPROVAL_NOT_FOUND | 409 APPROVAL_EXPIRED / APPROVAL_ALREADY_DECIDED
  Owner-only (session user). Flips the pending-write row; does NOT execute.
  Execution happens inside the resume stream (first act, before the provider
  call), so results stream as frames. `remaining` = unresolved rows left in
  the batch; the client opens the resume stream only when it reaches 0.

POST   /api/assistant/chat/:chatId/resume            (SSE — POST + fetch-stream)
POST   /api/assistant/threads/:documentType/:documentId/resume   (SSE)
  Same frames as the respective stream endpoints. Server-side sequence:
  sweep expired → execute approved rows in seq order (each emitting an
  approval_result frame right after start: applied|failed, error carries
  "CODE: message"; rejected rows emit denied) → continue the provider turn
  with no new user message → done.
  | 404 ASSISTANT_THREAD_NOT_FOUND / APPROVAL_NOT_FOUND (nothing to resume)
  | 409 ASSISTANT_TASK_ACTIVE | 409 APPROVALS_PENDING

GET    /api/assistant/chats/:projectId?q=
→ 200 { data: [{ chatId, title, pinned, snippet, createdAt, updatedAt }] }
  | 404 PROJECT_NOT_FOUND
  The caller's own chat threads for the project (owner-scoped — other users'
  threads are invisible), pinned threads first, then updatedAt DESC; capped
  at 100, flat. Optional `q` prefilter: case-exact LIKE substring over title
  or transcript text (% and _ escaped). `snippet` is a short window around
  the first transcript match (null for title-only matches). `title` is null
  until derived from the first text message or set via rename; first
  messages that are image-only arrays stay null until the next send.

PATCH  /api/assistant/chat/:chatId     body { title?, pinned? }
→ 200 { chatId, title, pinned } | 404 ASSISTANT_THREAD_NOT_FOUND | 422 INVALID_ARGS
  Updates an owned thread's metadata — at least one field must be present,
  else 422. `title`: 1–200 chars after trim (a later stream save keeps it —
  COALESCE backfill only fills NULL). `pinned`: boolean; pinned threads sort
  first in the list regardless of recency.

GET    /api/assistant/chat/:chatId/export
→ 200 text/markdown (attachment, filename "<sanitized-title|chat>-<YYYYMMDD>.md")
  | 404 ASSISTANT_THREAD_NOT_FOUND
  Owner-scoped markdown transcript: `# title` header, `**You**`/`**Assistant**`
  blocks (· ts suffix when the entry carries one), `[failed turn: CODE]` and
  `[stopped]` markers, citation lists under the turns that produced them.

GET    /api/assistant/memory/:projectId
→ 200 { data: [{ id, projectId, content, source: "manual"|"assistant",
                createdAt, updatedAt }] }
  Curated judgment-type facts injected into Assistant prompts (FTS5-matched at
  enqueue; K=5 hits, 2000-char cap).

POST   /api/assistant/memory/:projectId     body { content* }
→ 201 memory entry

DELETE /api/assistant/memory/:projectId/:memoryId
→ 204

  Assistant read tools (server-side toolset available to every assistant turn;
  project-scoped, read-only):
    web_search(query)                    Exa, ≤5 results (only when configured)
    fetch_url(url)                       SSRF-guarded plain text / PDF extract
    read_s3_file(key)                    project attachment text (5 MB cap)
    get_task(ref)                        ref = task id or PREFIX-n alias →
      { id, key, title, priority, dueAt, archived, markdown,
        columnName?, swimlaneName?, milestoneName?, type?,
        assignees?: string[], githubIssue?: { repo, number } | null }
    search_tasks(query, limit?)          ≤10 title-substring matches
    search_wiki(query, limit?)           FTS, ≤10 {title, slug, snippet}
    read_wiki_page(slug)                 { title, slug, markdown } (~8k cap)
    get_all_tasks()                      { tasks: [<get_task summary fields>
                                         + markdown], truncated? } — archived
                                         included; 60000-char total markdown
                                         cap, truncated:true = tasks dropped
    get_all_wiki_pages()                 { pages: [{title, slug, markdown}],
                                         truncated? } — each page ~8k cap,
                                         60000-char total cap
    get_board_structure()                { columns: [{id, name, position,
                                         wipLimit, githubState, isDone}],
                                         swimlanes: [{id, name, kind, startAt,
                                         dueAt, archived, milestoneId}],
                                         milestones: [{id, name, dueAt,
                                         archived}] }
```

## Notes

- **Mutation responses are authoritative.** Every mutating endpoint returns the updated entity. The frontend updates TanStack Query cache from the response (`setQueryData`) and never refetches on the mutation path — the response is the authoritative state.
- **`position` is opaque.** Clients never read or write it directly; ordering is expressed via `beforeTaskId`/`afterTaskId` (tasks) or `position` integer reassignment (columns/swimlanes/wiki siblings).
- **`:slug` in task routes is routing context**, not an authorization boundary. Project access is enforced by the authorization service (superadmin > explicit `user_project_roles` grant > team membership > deny); team admins act within their own teams only. Task IDs are globally unique UUIDs.
