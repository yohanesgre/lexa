# MCP Server Contract (v1)

> The agent-facing contract for Hermes / OpenCode. Shares Effect services with the REST API (LAYERS.md) but is a **separate, agent-ergonomic surface** — names over UUIDs, Markdown over TipTap JSON, summaries over full rows. Design lessons carried from the Linear evaluation: shorthand-friendly identifiers, single-call operations, generous-but-bounded reads.

## Transport & Auth

| Concern | Value |
|---------|-------|
| Endpoint | `https://<host>/mcp` (Bun server behind the cloudflared tunnel) |
| Method | **POST only** — any other method returns HTTP 405 |
| Protocol | MCP over **Streamable HTTP**, **stateless mode** (no session persistence — each request self-contained). `initialize` reports protocol `2025-03-26`, capabilities `{ tools: {} }`. Batch requests are rejected (`-32600` "Batch requests are not supported") |
| Auth | `Authorization: Bearer lxk_<base62(43)>` (must match `^lxk_[0-9A-Za-z]{43}$`) — same keys as REST. Missing/malformed/unknown key → HTTP 401 with JSON-RPC error code `-32001` ("Missing authorization" / "Invalid API key") |
| Sessions | **Never cross the MCP boundary** — `/mcp` is key-only; Better Auth cookie sessions exist only on REST/SSR (`/api/auth/*`, browser pages). No session cookie is accepted on `/mcp` |

## Remote MCP (client machines)

Use this when the agent runs on a machine that does **not** have `lexa-cli`
installed — e.g. a client workstation that only reads/updates tasks. The hosting
machine itself can just as well use `lexa-cli` locally; the MCP endpoint is for
agents without the CLI. No extra server-side setup: `/mcp` is key-only (Bearer
keys are the auth), TLS comes from the tunnel.

```json
{
  "mcpServers": {
    "lexa": {
      "type": "http",
      "url": "https://lexa.example.com/mcp",
      "headers": { "Authorization": "Bearer lxk_..." }
    }
  }
}
```

- **One key per client machine** — create the key in Settings → API keys, keep it
  only on that machine; revocation is then per-client. An unlinked key acts as
  admin; a user-linked key carries its user's id + role (attribution/runtime
  scoping only — see Access Control).
- **Rate limited per client IP** — 6000 req / 10 min default, configurable in
  Settings → API/Security (rate limiting): DB settings override
  `LXK_RATE_LIMIT_MAX` / `LXK_RATE_LIMIT_WINDOW_MS` env, applied live
  (`server/api/rate-limit.ts`). Agents behind a shared egress NAT all share one
  bucket; raise `max` if a fleet of clients trips it. The token-gated Forge
  machine surfaces (daemon log POSTs, runtime registration, listener heartbeat)
  are exempt.
- **16 MB body cap** applies; responses are JSON-RPC envelopes (never raw HTML).
- The local `lexa-cli` path (REST + Bearer) and the remote MCP path are
  interchangeable — same keys, same authorization model.

## Access Control

Keys are full read/write — **no scopes** (single-agent trust model, unchanged
by the auth rework). The old role-gated checks referencing `users.role` are
removed: every valid key may use every tool, including project mutations.
Key-owner identity (`api_keys.user_id` + `users.role`) is used only for
runtime scoping (team-scoped Forge runtimes), never for MCP authorization.

- API keys are stored hashed; a key may be **user-linked** (`api_keys.user_id`).
  An **unlinked key acts as admin** (user_id NULL — the seeded `LXK_API_KEY`
  and setup-wizard keys). A linked key carries its user's id + role for
  attribution/runtime scoping.
- `update_user_role` is **removed** — `users.role` (superadmin|member)
  derives solely from the env allow-list (`LXK_ADMIN_EMAILS`, applied at
  provisioning), never edited at runtime. There is no MCP tool to change it.
- Denied → tool error `FORBIDDEN` (details carry the reason).

## Content Format

**The MCP boundary speaks Markdown.** Agents never see ProseMirror JSON.

| Direction | Behavior |
|-----------|----------|
| MCP input (`description`, `content`) | Markdown string → server converts to TipTap JSON for storage |
| MCP output | TipTap JSON → server renders Markdown for the response |
| Fidelity | Headings, lists, checklists, code blocks, bold/italic, links, tables round-trip. Unsupported/unknown nodes degrade to plain text, never errors. |

## Identifier Ergonomics

| Reference | Accepted form | Resolution failure |
|-----------|---------------|--------------------|
| Project | `slug` (e.g. `"emberfall"`) | `PROJECT_NOT_FOUND` + `availableProjects` list |
| Column | **Name**, case-insensitive (e.g. `"in progress"`) | `COLUMN_NOT_FOUND` + `availableColumns` list |
| Swimlane | Name, case-insensitive | `SWIMLANE_NOT_FOUND` + list |
| Task | UUID (from `create_task`/`list_tasks` output) | `TASK_NOT_FOUND` |
| Wiki page | `pageSlug` | `PAGE_NOT_FOUND` + `availablePageSlugs` list |

Errors are designed for agent self-correction: `details` always includes the valid choices when a name lookup fails.

## Error Format

Tool failures return MCP-standard `isError: true` with a JSON text payload:

```json
{
  "content": [{
    "type": "text",
    "text": "{\"code\":\"WIP_LIMIT\",\"message\":\"Column 'In Progress' is at its WIP limit of 4\",\"details\":{\"column\":\"In Progress\",\"limit\":4,\"current\":4}}"
  }],
  "isError": true
}
```

Codes mirror the REST catalog: `PROJECT_NOT_FOUND`, `COLUMN_NOT_FOUND`, `SWIMLANE_NOT_FOUND`, `TASK_NOT_FOUND`, `PAGE_NOT_FOUND`, `SLUG_TAKEN`, `HAS_CHILDREN`, `WIP_LIMIT`, `ALREADY_LINKED`, `REQUIRED_FIELD`, `NEIGHBOR_NOT_IN_COLUMN`, `OPTION_IN_USE`, `INVALID_OPTION`, `INVALID_ARGS`, `INVALID_API_KEY`, `MISSING_AUTH`, `FORBIDDEN`, `USER_NOT_FOUND`, `API_KEY_NOT_FOUND`, `GITHUB_API_ERROR`, `DATABASE_ERROR`, `CONSTRAINT`, `INTERNAL`.

`LAST_ADMIN_DEMOTE` / `CANNOT_DELETE_SELF` are not raised on MCP — legacy
user-role editing is removed (`update_user_role` deleted; superadmin is
env-only).

## Response Shapes

Two granularities, chosen to protect the agent's context window:

```typescript
// Returned by list/move/create/archive/restore — compact, NO description
interface TaskSummary {
  id: string;
  title: string;
  column: string;              // name, not id
  swimlane: string | null;     // name; null = no swimlane
  priority: string;            // priority label (e.g. "High") — from project field-config
  type: string;                // type label (e.g. "Bug")
  priorityId: string;          // option id (stable identifier)
  typeId: string;
  assignees: string[];
  githubIssues: { number: number; repo: string; url: string; outOfSync: boolean }[];
  archivedAt: string | null;   // set when archived; null = live
  updatedAt: string;
}

// Returned by get_task/update_task — full, description as Markdown
interface TaskDetail extends TaskSummary {
  description: string;         // Markdown
  createdAt: string;
}

interface PageMeta { title: string; slug: string; parentSlug: string | null; updatedAt: string; }
```

## Tools

### Tasks

**`create_task`**
```json
Input:  { project*, column*, title*, description?, priority?, type?, assignees?, swimlane?, dueAt? }
        description = Markdown. priority/type are LABELS from the project's
        field-config (call get_project to list them); case-insensitive; omitted → first option.
        swimlane (name, case-insensitive) OPTIONAL — omitted → task lands in the project's
        Backlog lane. dueAt = "YYYY-MM-DD" — must not be later than the swimlane's due date.
Output: TaskSummary
Errors: PROJECT_NOT_FOUND, COLUMN_NOT_FOUND (+availableColumns), SWIMLANE_NOT_FOUND (+availableSwimlanes),
        DEADLINE_AFTER_LANE {date}, REQUIRED_FIELD, INVALID_OPTION (+availablePriorities/availableTypes)
```

**`list_tasks`**
```json
Input:  { project*, column?, swimlane?, assignee?, type?, limit?, cursor?, includeArchived? }
        type = type LABEL (case-insensitive) from field-config.
        limit: default 50, max 200. includeArchived: default false.
Output: { tasks: TaskSummary[], nextCursor: string | null }
```

**`get_task`**
```json
Input:  { taskId* }
Output: TaskDetail (description as Markdown)
```

**`update_task`**
```json
Input:  { taskId*, title?, description?, priority?, type?, assignees?, dueAt? }
        description = Markdown (full replace). assignees: empty array clears.
        priority/type are LABELS (case-insensitive). dueAt: "YYYY-MM-DD";
        empty string clears. Must not be later than the lane's due date.
Output: TaskDetail
Errors: TASK_NOT_FOUND, DEADLINE_AFTER_LANE {date}, REQUIRED_FIELD, INVALID_OPTION (+availablePriorities/availableTypes)
```

**`move_task`**
```json
Input:  { taskId*, column*, beforeTaskId?, afterTaskId? }
        column = name. beforeTaskId/afterTaskId name the NEIGHBORS that will
        precede/follow the moved task (not placement targets); both omitted →
        append to end of column.
Output: TaskSummary
Errors: TASK_NOT_FOUND, COLUMN_NOT_FOUND, WIP_LIMIT {column,limit,current},
        REQUIRED_FIELD {field,column}, NEIGHBOR_NOT_IN_COLUMN
Notes: within-column reorder never fails WIP. If the task is GitHub-linked and the
       target column maps to a state, sync fires best-effort; check outOfSync in output.
```

**`delete_task`**
```json
Input:  { taskId* }
Output: { deleted: true }
Errors: TASK_NOT_FOUND, TASK_HAS_CHILDREN (defensive — subtask links cascade on delete)
```

**`archive_task`**
```json
Input:  { taskId* }
Output: TaskSummary (archivedAt set)
Errors: TASK_NOT_FOUND
Notes: idempotent. Archived tasks keep their column/position but are hidden
       from the board (and list_tasks by default) until restored.
```

**`restore_task`**
```json
Input:  { taskId* }
Output: TaskSummary (archivedAt null)
Errors: TASK_NOT_FOUND
Notes: idempotent. Restores the task to its original column/position.
```

**`get_task_activity`**
```json
Input:  { taskId*, cursor? }
Output: { activity: [{ type, actor, at, message, comment?: { markdown } }], nextCursor }
Errors: TASK_NOT_FOUND
Notes: Activity timeline for the task, oldest first. Events (moves, field
       changes, links, GitHub sync, Forge runs) and comments — comments are
       serialized as Markdown (comment.markdown). Pass nextCursor for older
       entries. Same page as the REST endpoint.
```

**`add_task_comment`**
```json
Input:  { taskId*, comment* }
Output: { id, authorLabel, body (Markdown), createdAt }
Errors: TASK_NOT_FOUND, COMMENT_INVALID
Notes: The comment is Markdown; stored as rich text and rendered in the Lexa
       UI. The agent's API key name is recorded as the author. Agents have NO
       comment edit/delete tools — comments are append-only from MCP.
       A missing/empty comment yields COMMENT_INVALID (there is no INVALID_ARGS
       validation on this tool).
```

### Wiki

**`get_wiki_page`**
```json
Input:  { project*, pageSlug* }
Output: { title, slug, content (Markdown), parentSlug, updatedAt }
```

**`create_wiki_page`**
```json
Input:  { project*, title*, content?, parentSlug? }
        content = Markdown. parentSlug nests under that page.
Output: PageMeta
Errors: SLUG_TAKEN {slug}, PAGE_NOT_FOUND (bad parentSlug)
```

**`update_wiki_page`**
```json
Input:  { project*, pageSlug*, title?, content? }
Output: PageMeta
Errors: PAGE_NOT_FOUND
```

**`list_wiki_pages`**
```json
Input:  { project*, limit?, cursor? }
Output: { pages: PageMeta[], nextCursor }
```

**`search_wiki`**
```json
Input:  { project*, query*, limit? }
        FTS5-backed. limit default 10, max 50.
Output: { results: [{ title, slug, snippet }] }
        snippet: match context with **bold** around hits (Markdown-safe, no HTML)
```

### GitHub

**`link_github_issue`**
```json
Input:  { taskId*, repo* }        repo = "owner/name" — creates a GitHub issue from the task
Output: { issueNumber, url }
Errors: TASK_NOT_FOUND, ALREADY_LINKED, GITHUB_API_ERROR
Notes: a task may hold several GitHub issues, one per repo — linking a second
       issue to the same repo fails with ALREADY_LINKED. repo must be a
       WORKSPACE repo of the task's project — otherwise GITHUB_API_ERROR
       (workspace validation runs first).
```

**`unlink_github_issue`**
```json
Input:  { taskId*, issueId* }     issueId = GitHub node_id to unlink
Output: { unlinked: true }        (GitHub issue is NOT closed or deleted)
```

**`list_github_issues`**
```json
Input:  { project*, repo*, query? }
        repo = "owner/name" and must be a WORKSPACE repo of the project
        (otherwise GITHUB_API_ERROR). query optional — filters the recent
        issues list (per_page=100; exact "#number" does a direct issue GET
        fallback). Already-linked issues excluded.
Output: { issues: [{ issueNumber, title, state, url }] }
Errors: PROJECT_NOT_FOUND, GITHUB_API_ERROR
```

**`create_task_from_github_issue`**
```json
Input:  { project*, repo*, issueNumber* }
        repo must be a WORKSPACE repo of the project. Creates a task in the
        project's first column (Backlog) from the issue — title + description
        seeded (Markdown), issue auto-linked. required_fields enforced like a
        normal create.
Output: { taskId, issueNumber, url }
Errors: PROJECT_NOT_FOUND, GITHUB_API_ERROR, ALREADY_LINKED, REQUIRED_FIELD
```

### Projects

**`list_projects`**
```json
Input:  {}
Output: { projects: [{ name, slug, description, taskCount }] }
Notes: all projects (keys are global full-access).
```

**`get_project`**
```json
Input:  { slug* }
Output: { name, slug, description,
          repos: [{ repo, sourceRole, workspaceRole }],   // linked repos with roles
          columns: [{ name, wipLimit, requiredFields, githubState }],
          swimlanes: [{ name }],
          priorities: [{ id, label, color, position }],
          types: [{ id, label, color, position }] }
        Priorities/types are the project's field-config — use the LABELS when
        calling create_task/update_task/list_tasks.
```

**`get_project_status`**
```json
Input:  { slug* }
Output: { columns: [{ name, count, wipLimit }], totalTasks }
         Cheap board-health snapshot — use this before batch moves.
         Lightweight agent tool (no urgent/sync/dashboard-level aggregation).
         Dashboard health aggregation is the REST GET /api/dashboard endpoint.
```

**`create_project`**
```json
Input:  { name*, slug?, description?, team? }
        slug auto-generated from name if omitted.
        team = team slug (optional): assigns the project to that team
        (projects.team_id). Unknown team slug → error with
        details.availableTeams.
Output: { name, slug, description, createdAt, updatedAt, teamId }
Errors: FORBIDDEN, SLUG_TAKEN, CONSTRAINT
```

**`update_project`**
```json
Input:  { slug*, name?, description? }
Output: { name, slug, description, createdAt, updatedAt }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`link_project_repo`**
```json
Input:  { project*, repo*, sourceRole?, workspaceRole? }
        repo = "owner/name". At least one role required (both omitted → error).
        Roles are booleans; a repo can be source, workspace, or both. Idempotent
        — re-linking an existing repo updates its roles.
Output: { repo, sourceRole, workspaceRole }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, INVALID_ARGS
```

**`unlink_project_repo`**
```json
Input:  { project*, repo* }      repo = "owner/name"
Output: { unlinked: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, INVALID_ARGS (+availableRepos)
Notes: removes the repo row entirely (both roles). Existing task↔issue links
       keep syncing — roles gate NEW links only.
```

**`delete_project`**
```json
Input:  { slug* }
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
Notes: removes all tasks, wiki pages, columns, and swimlanes.
```

### Board Structure (columns & swimlanes)

**`create_column`**
```json
Input:  { project*, name*, color?, wipLimit?, requiredFields?, githubState? }
        githubState: "open" | "closed" (GitHub issue state mapping).
Output: { id, name, wipLimit, requiredFields, githubState, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`update_column`**
```json
Input:  { project*, column*, name?, color?, wipLimit?, requiredFields?, githubState? }
        column = name (case-insensitive). wipLimit: null removes the limit.
Output: { id, name, wipLimit, requiredFields, githubState, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, COLUMN_NOT_FOUND (+availableColumns)
```

**`delete_column`**
```json
Input:  { project*, column* }     column = name (case-insensitive)
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, COLUMN_NOT_FOUND, HAS_CHILDREN
Notes: column must be empty (no tasks).
```

**`create_swimlane`**
```json
Input:  { project*, name*, description?, dueAt? }
        dueAt = "YYYY-MM-DD" milestone deadline; empty string clears. Lanes are
        always created as kind 'milestone' — the Backlog lane is system-seeded.
Output: { id, name, description, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`update_swimlane`**
```json
Input:  { project*, swimlane*, name?, description?, dueAt? }
        swimlane = name (case-insensitive). dueAt: empty string clears.
        Setting dueAt earlier than a live task's deadline → DEADLINE_AFTER_LANE.
        dueAt on the Backlog lane → BACKLOG_PROTECTED.
Output: { id, name, description, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND, DEADLINE_AFTER_LANE {date}, BACKLOG_PROTECTED
```

**`delete_swimlane`**
```json
Input:  { project*, swimlane* }   swimlane = name (case-insensitive)
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND, HAS_CHILDREN, BACKLOG_PROTECTED
Notes: swimlane must be empty (no tasks). The Backlog lane cannot be deleted.
```

**`archive_swimlane`**
```json
Input:  { project*, swimlane* }   swimlane = name (case-insensitive)
Output: { message: 'Archived swimlane "<name>" (<n> tasks archived)' }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND, BACKLOG_PROTECTED
Notes: one transaction — the lane AND all its live tasks are archived (per-task
       `archived` activity rows). Idempotent. The Backlog lane cannot be archived.
```

**`restore_swimlane`**
```json
Input:  { project*, swimlane* }   swimlane = name (case-insensitive)
Output: { message: 'Restored swimlane "<name>"' }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND
Notes: lane only — tasks stay archived (restore individually). Idempotent.
```

### Administration (API keys, users, project grants)

**`list_api_keys`**
```json
Input:  {}
Output: { data: [{ id, name, createdAt, lastUsedAt }] }
Notes: key hashes are never returned — metadata only.
```

**`create_api_key`**
```json
Input:  { name* }
Output: { key: { id, name, createdAt }, rawKey }
Notes: rawKey is shown once — save it immediately.
```

**`delete_api_key`**
```json
Input:  { id* }
Output: { deleted: true }
Errors: FORBIDDEN, API_KEY_NOT_FOUND
```

**`list_users`**
```json
Input:  {}
Output: { users: [{ id, email, name, role, createdAt, lastSeen }] }
        role: "superadmin" | "member" — env-only, read-only via MCP
```

**`list_user_project_roles`**
```json
Input:  { userId* }
Output: { data: [{ projectId, projectSlug, role }] }
Errors: FORBIDDEN, USER_NOT_FOUND
```

**`set_user_project_role`**
```json
Input:  { userId*, project*, role* }
        project = slug. role: "admin" | "member".
Output: { userId, projectSlug, role }
Errors: FORBIDDEN, USER_NOT_FOUND, PROJECT_NOT_FOUND
```

**`remove_user_project_role`**
```json
Input:  { userId*, project* }     project = slug
Output: { removed: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

## Agent Usage Notes (included in tool descriptions)

1. **Names, not UUIDs** — pass `"In Progress"`, not a column UUID. Task IDs are the only UUIDs you need, and they come from `create_task`/`list_tasks`. Priority/type are passed as LABELS from the project's field-config (e.g. `"High"`, `"Bug"`); call `get_project` to see the valid labels.
2. **Markdown everywhere** — descriptions and wiki content are plain Markdown.
3. **Summaries vs details** — `list_tasks` omits descriptions on purpose; call `get_task` only for tasks you actually need to read.
4. **Self-correcting errors** — when a name lookup fails, the error's `details.available*` lists the valid options. Retry with one of those.
5. **`get_project_status` before batch work** — check WIP headroom before planning a set of moves.
6. **GitHub sync is best-effort** — after `move_task`, inspect `githubIssue.outOfSync`; if true, the board is correct and GitHub will converge later (or re-move to retry).
7. **Keys are global** — every valid key can use every tool (single-agent
   trust model); there are no role gates on MCP. Key-owner identity is used
   only for Forge runtime scoping. Human sessions (cookies) never reach `/mcp`.
