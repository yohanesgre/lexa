# MCP Server Contract (v1)

> The agent-facing contract for Hermes / OpenCode. Shares Effect services with the REST API (LAYERS.md) but is a **separate, agent-ergonomic surface** — names over UUIDs, Markdown over TipTap JSON, summaries over full rows. Design lessons carried from the Linear evaluation: shorthand-friendly identifiers, single-call operations, generous-but-bounded reads.

## Transport & Auth

| Concern | Value |
|---------|-------|
| Endpoint | `https://<host>/mcp` (Bun server behind the cloudflared tunnel) |
| Method | **POST only** — any other method returns HTTP 405 |
| Protocol | MCP over **Streamable HTTP**, **stateless mode** (no session persistence — each request self-contained). `initialize` reports protocol `2025-03-26`, capabilities `{ tools: {} }`. Batch requests are rejected (`-32600` "Batch requests are not supported") |
| Auth | `Authorization: Bearer lxk_<base62(43)>` (must match `^lxk_[0-9A-Za-z]{43}$`) — same keys as REST. Missing/malformed/unknown key → HTTP 401 with JSON-RPC error code `-32001` ("Missing authorization" / "Invalid API key") |
| Access bypass | `/mcp` is on a Cloudflare Access **bypass** policy — Bearer key is the only auth on this route |

## Remote MCP (client machines)

Use this when the agent runs on a machine that does **not** have `lexa-cli`
installed — e.g. a client workstation that only reads/updates tasks. The hosting
machine itself can just as well use `lexa-cli` locally; the MCP endpoint is for
agents without the CLI. No extra server-side setup: `/mcp` is already
Access-bypassed, TLS comes from the tunnel, and Bearer keys are the auth.

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
  only on that machine; revocation is then per-client. An unlinked key is `admin`;
  a user-linked key inherits the user's role and project grants (see Access Control).
- **Rate limited per client IP** — 600 req / 10 min default (`server/api/rate-limit.ts`
  constants). Agents behind a shared egress NAT all share one bucket; raise `max`
  if a fleet of clients trips it.
- **16 MB body cap** applies; responses are JSON-RPC envelopes (never raw HTML).
- The local `lexa-cli` path (REST + Bearer) and the remote MCP path are
  interchangeable — same keys, same authorization model.

## Access Control

Keys are **not** blanket read/write. Access is role-scoped per project:

- API keys are stored hashed; a key may be **user-linked** (`api_keys.user_id`). An **unlinked key acts as `admin`**. A linked key inherits its user's global role: `admin` (global — every project, plus the admin-only tools below) or `member` (only projects the user is granted via user-project-role).
- Project-scoped checks run **before** the tool handler:
  - Tools with a `project` argument (project slug) resolve the project, then check access.
  - `get_project` / `get_project_status` take `slug` — same check.
  - `get_task` / `update_task` / `move_task` / `delete_task` / `archive_task` / `restore_task` / `link_github_issue` / `unlink_github_issue` take `taskId` — the owning project is resolved from the task, then checked.
  - Denied → tool error `FORBIDDEN` (details carry the reason). A non-admin referencing an unknown project also gets `FORBIDDEN`, not `PROJECT_NOT_FOUND`.
- `list_projects`: admins see all projects; members see only granted projects.
- **Admin-only tools** (enforced in the handler — `FORBIDDEN` unless the key's role is `admin`): `create_project`/`update_project`/`delete_project`, `create_column`/`update_column`/`delete_column`, `create_swimlane`/`update_swimlane`/`delete_swimlane`, `list_api_keys`/`create_api_key`/`delete_api_key`, `list_users`/`update_user_role`, `list_user_project_roles`/`set_user_project_role`/`remove_user_project_role`.

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

Codes mirror the REST catalog: `PROJECT_NOT_FOUND`, `COLUMN_NOT_FOUND`, `SWIMLANE_NOT_FOUND`, `TASK_NOT_FOUND`, `PAGE_NOT_FOUND`, `SLUG_TAKEN`, `HAS_CHILDREN`, `WIP_LIMIT`, `ALREADY_LINKED`, `REQUIRED_FIELD`, `NEIGHBOR_NOT_IN_COLUMN`, `OPTION_IN_USE`, `INVALID_OPTION`, `INVALID_ARGS`, `INVALID_API_KEY`, `MISSING_AUTH`, `FORBIDDEN`, `USER_NOT_FOUND`, `API_KEY_NOT_FOUND`, `CANNOT_DELETE_SELF`, `LAST_ADMIN_DEMOTE`, `GITHUB_API_ERROR`, `DATABASE_ERROR`, `CONSTRAINT`, `INTERNAL`.

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
Input:  { project*, column*, title*, description?, priority?, type?, assignees?, swimlane* }
        description = Markdown. priority/type are LABELS from the project's
        field-config (call get_project to list them); case-insensitive; omitted → first option.
        swimlane required (name, case-insensitive) — tasks always belong to a swimlane (schema NOT NULL).
Output: TaskSummary
Errors: PROJECT_NOT_FOUND, COLUMN_NOT_FOUND (+availableColumns), SWIMLANE_NOT_FOUND (+availableSwimlanes),
        REQUIRED_FIELD, INVALID_OPTION (+availablePriorities/availableTypes)
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
Input:  { taskId*, title?, description?, priority?, type?, assignees? }
        description = Markdown (full replace). assignees: empty array clears.
        priority/type are LABELS (case-insensitive).
Output: TaskDetail
Errors: TASK_NOT_FOUND, REQUIRED_FIELD, INVALID_OPTION (+availablePriorities/availableTypes)
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
Errors: PAGE_NOT_FOUND, SLUG_TAKEN
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
       issue to the same repo fails with ALREADY_LINKED.
```

**`unlink_github_issue`**
```json
Input:  { taskId*, issueId* }     issueId = GitHub node_id to unlink
Output: { unlinked: true }        (GitHub issue is NOT closed or deleted)
```

### Projects

**`list_projects`**
```json
Input:  {}
Output: { projects: [{ name, slug, description, taskCount }] }
Notes: admins see all projects; members see only granted projects.
```

**`get_project`**
```json
Input:  { slug* }
Output: { name, slug, description, githubRepo,
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

**`create_project`** — Admin only
```json
Input:  { name*, slug?, description?, githubRepo? }
        slug auto-generated from name if omitted.
Output: { name, slug, description, githubRepo, createdAt, updatedAt }
Errors: FORBIDDEN, SLUG_TAKEN, CONSTRAINT
```

**`update_project`** — Admin only
```json
Input:  { slug*, name?, description?, githubRepo? }
Output: { name, slug, description, githubRepo, createdAt, updatedAt }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`delete_project`** — Admin only
```json
Input:  { slug* }
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
Notes: removes all tasks, wiki pages, columns, and swimlanes.
```

### Board Structure (columns & swimlanes)

**`create_column`** — Admin only
```json
Input:  { project*, name*, color?, wipLimit?, requiredFields?, githubState? }
        githubState: "open" | "closed" (GitHub issue state mapping).
Output: { id, name, wipLimit, requiredFields, githubState, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`update_column`** — Admin only
```json
Input:  { project*, column*, name?, color?, wipLimit?, requiredFields?, githubState? }
        column = name (case-insensitive). wipLimit: null removes the limit.
Output: { id, name, wipLimit, requiredFields, githubState, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, COLUMN_NOT_FOUND (+availableColumns)
```

**`delete_column`** — Admin only
```json
Input:  { project*, column* }     column = name (case-insensitive)
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, COLUMN_NOT_FOUND, HAS_CHILDREN
Notes: column must be empty (no tasks).
```

**`create_swimlane`** — Admin only
```json
Input:  { project*, name*, description? }
Output: { id, name, description, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND
```

**`update_swimlane`** — Admin only
```json
Input:  { project*, swimlane*, name?, description? }
        swimlane = name (case-insensitive).
Output: { id, name, description, position }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND
```

**`delete_swimlane`** — Admin only
```json
Input:  { project*, swimlane* }   swimlane = name (case-insensitive)
Output: { deleted: true }
Errors: FORBIDDEN, PROJECT_NOT_FOUND, SWIMLANE_NOT_FOUND, HAS_CHILDREN
Notes: swimlane must be empty (no tasks).
```

### Administration (API keys, users, project grants)

**`list_api_keys`** — Admin only
```json
Input:  {}
Output: { data: [{ id, name, createdAt, lastUsedAt }] }
Notes: key hashes are never returned — metadata only.
```

**`create_api_key`** — Admin only
```json
Input:  { name* }
Output: { key: { id, name, createdAt }, rawKey }
Notes: rawKey is shown once — save it immediately.
```

**`delete_api_key`** — Admin only
```json
Input:  { id* }
Output: { deleted: true }
Errors: FORBIDDEN, API_KEY_NOT_FOUND
```

**`list_users`** — Admin only
```json
Input:  {}
Output: { users: [{ id, email, name, role, createdAt, lastSeen }] }
```

**`update_user_role`** — Admin only
```json
Input:  { userId*, role* }        role: "admin" | "member"
Output: { id, email, name, role }
Errors: FORBIDDEN, USER_NOT_FOUND, CANNOT_DELETE_SELF
Notes: demoting yourself fails with CANNOT_DELETE_SELF.
```

**`list_user_project_roles`** — Admin only
```json
Input:  { userId* }
Output: { data: [{ projectId, projectSlug, role }] }
Errors: FORBIDDEN, USER_NOT_FOUND
```

**`set_user_project_role`** — Admin only
```json
Input:  { userId*, project*, role* }
        project = slug. role: "admin" | "member".
Output: { userId, projectSlug, role }
Errors: FORBIDDEN, USER_NOT_FOUND, PROJECT_NOT_FOUND
```

**`remove_user_project_role`** — Admin only
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
7. **Access is role-scoped** — a member key sees only granted projects and gets `FORBIDDEN` on anything else. Admin-only tools (project/column/swimlane/API-key/user/role management) require an admin key.
