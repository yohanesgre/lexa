# MCP Server Contract (v1)

> The agent-facing contract for Hermes / OpenCode. Shares Effect services with the REST API (LAYERS.md) but is a **separate, agent-ergonomic surface** — names over UUIDs, Markdown over TipTap JSON, summaries over full rows. Design lessons carried from the Linear evaluation: shorthand-friendly identifiers, single-call operations, generous-but-bounded reads.

## Transport & Auth

| Concern | Value |
|---------|-------|
| Endpoint | `https://<worker-host>/mcp` |
| Protocol | MCP over **Streamable HTTP**, **stateless mode** (no session persistence — each request self-contained; fits Workers) |
| Auth | `Authorization: Bearer lxk_<base62(32B)>` — same keys as REST. Keys are full read/write (no scopes — single-agent trust model, documented) |
| Access bypass | `/mcp` is on a Cloudflare Access **bypass** policy — Bearer key is the only auth on this route |

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
| Wiki page | `pageSlug` | `PAGE_NOT_FOUND` + sibling slugs |

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

Codes mirror the REST catalog: `PROJECT_NOT_FOUND`, `COLUMN_NOT_FOUND`, `SWIMLANE_NOT_FOUND`, `TASK_NOT_FOUND`, `PAGE_NOT_FOUND`, `SLUG_TAKEN`, `HAS_CHILDREN`, `WIP_LIMIT`, `ALREADY_LINKED`, `REQUIRED_FIELD`, `NEIGHBOR_NOT_IN_COLUMN`, `INVALID_API_KEY`, `MISSING_AUTH`, `GITHUB_API_ERROR`, `DATABASE_ERROR`, `CONSTRAINT`, `INTERNAL`.

## Response Shapes

Two granularities, chosen to protect the agent's context window:

```typescript
// Returned by list/move/create — compact, NO description
interface TaskSummary {
  id: string;
  title: string;
  column: string;              // name, not id
  swimlane: string | null;     // name
  priority: "urgent" | "high" | "medium" | "low";
  type: "feature" | "bug" | "task" | "asset";
  assignee: string | null;
  githubIssue: { number: number; repo: string; url: string; outOfSync: boolean } | null;
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
Input:  { project*, column*, title*, description?, priority?, type?, assignee?, swimlane? }
        description = Markdown. priority/type default "medium"/"task".
Output: TaskSummary
Errors: PROJECT_NOT_FOUND, COLUMN_NOT_FOUND (+availableColumns), SWIMLANE_NOT_FOUND, REQUIRED_FIELD
```

**`list_tasks`**
```json
Input:  { project*, column?, swimlane?, assignee?, type?, limit?, cursor? }
        limit: default 50, max 200.
Output: { tasks: TaskSummary[], nextCursor: string | null }
```

**`get_task`**
```json
Input:  { taskId* }
Output: TaskDetail (description as Markdown)
```

**`update_task`**
```json
Input:  { taskId*, title?, description?, priority?, type?, assignee? }
        description = Markdown (full replace). assignee: explicit null clears.
Output: TaskDetail
Errors: TASK_NOT_FOUND, REQUIRED_FIELD
```

**`move_task`**
```json
Input:  { taskId*, column*, beforeTaskId?, afterTaskId? }
        column = name. before/after omitted → append to end of column.
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
```

**`unlink_github_issue`**
```json
Input:  { taskId* }
Output: { unlinked: true }        (GitHub issue is NOT closed or deleted)
```

### Projects

**`list_projects`**
```json
Input:  {}
Output: { projects: [{ name, slug, description, taskCount }] }
```

**`get_project`**
```json
Input:  { slug* }
Output: { name, slug, description, githubRepo,
          columns: [{ name, wipLimit, requiredFields, githubState }],
          swimlanes: [{ name }] }
```

**`get_project_status`**
```json
Input:  { slug* }
Output: { columns: [{ name, count, wipLimit }], totalTasks }
        Cheap board-health snapshot — use this before batch moves.
```

## Agent Usage Notes (included in tool descriptions)

1. **Names, not UUIDs** — pass `"In Progress"`, not a column UUID. Task IDs are the only UUIDs you need, and they come from `create_task`/`list_tasks`.
2. **Markdown everywhere** — descriptions and wiki content are plain Markdown.
3. **Summaries vs details** — `list_tasks` omits descriptions on purpose; call `get_task` only for tasks you actually need to read.
4. **Self-correcting errors** — when a name lookup fails, the error's `details.available*` lists the valid options. Retry with one of those.
5. **`get_project_status` before batch work** — check WIP headroom before planning a set of moves.
6. **GitHub sync is best-effort** — after `move_task`, inspect `githubIssue.outOfSync`; if true, the board is correct and GitHub will converge later (or re-move to retry).
