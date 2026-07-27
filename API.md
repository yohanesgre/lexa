# REST API Contract (v1)

> Derived from ARCHITECTURE.md (v2.1) routes and LAYERS.md (v2.1) services. This is the frontend↔backend contract. For the agent-facing contract see MCP.md.

## Conventions

| Concern | Convention |
|---------|-----------|
| Base URL | `https://<worker-host>/api` |
| Auth (human) | Cloudflare Access — JWT verified via `Cf-Access-Jwt-Assertion`; identity from `Cf-Access-Authenticated-User-Email` |
| Auth (machine) | `Authorization: Bearer lxk_<base62(32B)>` |
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
| 400 | `BAD_REQUEST` | Malformed JSON / validation failure (details: field errors) |
| 401 | `MISSING_AUTH` / `INVALID_API_KEY` / `INVALID_ACCESS_JWT` | No/invalid credentials |
| 404 | `PROJECT_NOT_FOUND` `COLUMN_NOT_FOUND` `SWIMLANE_NOT_FOUND` `TASK_NOT_FOUND` `PAGE_NOT_FOUND` | |
| 409 | `SLUG_TAKEN` | Duplicate project slug or wiki slug (details: `{ slug }`) |
| 409 | `HAS_CHILDREN` | Delete column with tasks / wiki page with children (details: `{ count }`) |
| 409 | `WIP_LIMIT` | Move would exceed column WIP limit |
| 409 | `ALREADY_LINKED` | Task already has a GitHub issue |
| 422 | `REQUIRED_FIELD` | Column's `required_fields` not satisfied (details: `{ field, column }`) |
| 422 | `NEIGHBOR_NOT_IN_COLUMN` | `beforeTaskId`/`afterTaskId` not in target column |
| 500 | `DATABASE_ERROR` / `CONSTRAINT` / `INTERNAL` | |
| 502 | `GITHUB_API_ERROR` | Only on explicit GitHub-linking endpoints; never on moves |

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
  position: number;
}

type Priority = "urgent" | "high" | "medium" | "low";
type TaskType = "feature" | "bug" | "task" | "asset";

interface Task {
  id: ID;
  projectId: ID;
  columnId: ID;
  swimlaneId: ID | null;
  title: string;
  description: TipTapDoc;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  position: string;               // fractional-index key (opaque to clients)
  github: {
    issueId: string;
    issueNumber: number;
    repo: string;                 // "owner/name"
    url: string;                  // derived: github.com/<repo>/issues/<n>
    syncedState: "open" | "closed" | null;
    outOfSync: boolean;           // derived: syncedState !== column's githubState
  } | null;
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
  updatedAt: ISODate;
}

interface WikiPage extends WikiPageMeta {
  content: TipTapDoc;
  createdAt: ISODate;
}

interface ApiKey {
  id: ID;
  name: string;
  createdAt: ISODate;
  lastUsedAt: ISODate | null;
}

interface Board {                 // GET /board — full snapshot, unpaginated
  project: Project;
  columns: Column[];              // ordered by position
  swimlanes: Swimlane[];          // ordered by position
  tasks: Task[];                  // ALL tasks, ordered by (columnId, position)
}
```

## Endpoints

### Projects

```
GET    /api/projects
→ 200 { data: Project[], nextCursor }

POST   /api/projects
body { name*, slug?, description?, githubRepo? }
→ 201 Project | 409 SLUG_TAKEN

GET    /api/projects/:slug
→ 200 Project | 404

PATCH  /api/projects/:slug
body { name?, description?, githubRepo? }
→ 200 Project | 404

DELETE /api/projects/:slug
→ 204 | 404        (cascades: columns, swimlanes, tasks, wiki)
```

### Columns

```
GET    /api/projects/:slug/columns
→ 200 { data: Column[] }         (ordered by position; not paginated — bounded by nature)

POST   /api/projects/:slug/columns
body { name*, position?, color?, wipLimit?, requiredFields?, githubState? }
→ 201 Column | 404 PROJECT_NOT_FOUND
  position omitted → appended to end

PATCH  /api/projects/:slug/columns/:id
body { name?, color?, wipLimit?, requiredFields?, githubState?, position? }
→ 200 Column | 404

DELETE /api/projects/:slug/columns/:id
→ 204 | 409 HAS_CHILDREN { count }   (must migrate tasks first)
```

### Swimlanes

```
GET    /api/projects/:slug/swimlanes        → 200 { data: Swimlane[] }
POST   /api/projects/:slug/swimlanes        body { name*, position? } → 201 Swimlane
PATCH  /api/projects/:slug/swimlanes/:id    body { name?, position? } → 200 Swimlane
DELETE /api/projects/:slug/swimlanes/:id    → 204 (tasks' swimlane_id → NULL, not deleted)
```

### Tasks

```
GET    /api/projects/:slug/tasks?columnId&swimlaneId&assignee&type&limit&cursor
→ 200 { data: Task[], nextCursor }

POST   /api/projects/:slug/tasks
body { columnId*, swimlaneId?, title*, description?, priority?, type?, assignee? }
→ 201 Task
  | 404 COLUMN_NOT_FOUND / SWIMLANE_NOT_FOUND
  | 422 REQUIRED_FIELD            (creating directly into a guarded column)
  position: appended to end of column

GET    /api/projects/:slug/tasks/:id
→ 200 Task | 404

PATCH  /api/projects/:slug/tasks/:id
body { title?, description?, priority?, type?, assignee? }
→ 200 Task | 404 | 422 REQUIRED_FIELD   (can't clear a required field in guarded column)

POST   /api/projects/:slug/tasks/:id/move
body { columnId*, swimlaneId?, beforeTaskId?, afterTaskId? }
  - swimlaneId omitted → keep current; explicit null → clear
  - beforeTaskId/afterTaskId omitted → append to end of target column
  - before/after must belong to target column
→ 200 Task
  | 404 TASK_NOT_FOUND / COLUMN_NOT_FOUND / SWIMLANE_NOT_FOUND
  | 409 WIP_LIMIT
  | 422 REQUIRED_FIELD / NEIGHBOR_NOT_IN_COLUMN
  (within-column reorder never fails WIP)
  Side effect: if target column has githubState and task is linked,
  best-effort GitHub state sync fires (failure does not fail the request;
  task.github.outOfSync becomes true)

DELETE /api/projects/:slug/tasks/:id
→ 204 | 404

GET    /api/projects/:slug/board
→ 200 Board          (unpaginated full snapshot — the kanban's single fetch)
```

### Task ↔ GitHub link

```
POST   /api/projects/:slug/tasks/:id/github-link
body { repo* }                   ("owner/name" — creates a GitHub issue from the task)
→ 200 Task (with github populated) | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR

DELETE /api/projects/:slug/tasks/:id/github-link
→ 200 Task (github: null) | 404  (does NOT close/delete the GitHub issue)
```

### Wiki

```
GET    /api/projects/:slug/wiki?parentId&limit&cursor
→ 200 { data: WikiPageMeta[], nextCursor }
  parentId omitted → root pages; "null" → root pages explicitly

POST   /api/projects/:slug/wiki
body { title*, slug?, content?, parentId? }
→ 201 WikiPage | 404 PROJECT_NOT_FOUND | 409 SLUG_TAKEN

GET    /api/projects/:slug/wiki/:pageSlug
→ 200 WikiPage | 404 PAGE_NOT_FOUND

PATCH  /api/projects/:slug/wiki/:pageSlug
body { title?, slug?, content?, parentId?, position? }
→ 200 WikiPage | 404 | 409 SLUG_TAKEN

DELETE /api/projects/:slug/wiki/:pageSlug
→ 204 | 404 | 409 HAS_CHILDREN { count }

GET    /api/projects/:slug/wiki/:pageSlug/children
→ 200 { data: WikiPageMeta[] }     (ordered by position)

GET    /api/projects/:slug/wiki/search?q*&limit
→ 200 { data: [{ id, title, slug, snippet }] }
  snippet: FTS5 match context (~160 chars, <mark> tags around hits)
```

### Settings

```
GET    /api/settings/api-keys
→ 200 { data: ApiKey[] }

POST   /api/settings/api-keys
body { name* }
→ 201 { key: ApiKey, rawKey: "lxk_..." }
  ⚠ rawKey returned ONCE — never stored, never shown again

DELETE /api/settings/api-keys/:id
→ 204 | 404
```

### GitHub Webhook (no API-key middleware)

```
POST   /api/webhooks/github
headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
→ 200 immediately (processing deferred via ctx.waitUntil)
→ 401 on signature mismatch (before body parsing)
Handled events: issues.closed, issues.reopened, issues.edited
```

## Notes

- **Mutation responses are authoritative.** Every mutating endpoint returns the updated entity. The frontend updates TanStack Query cache from the response (`setQueryData`) and never refetches on the mutation path — D1 is read-replicated.
- **`position` is opaque.** Clients never read or write it directly; ordering is expressed via `beforeTaskId`/`afterTaskId` (tasks) or `position` integer reassignment (columns/swimlanes/wiki siblings).
- **`:slug` in task routes is routing context**, not an authorization boundary in v1 (single-tenant, Access-gated). Task IDs are globally unique UUIDs.
