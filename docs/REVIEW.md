# Design Review — Lexa

> Oracle review (kimi-k3) of ARCHITECTURE.md, SCHEMA.md, LAYERS.md  
> Verdict: bones are good, but 5 blockers + 14 should-fix items before coding.

> **Post-implementation migration note (2026-07-31):** The runtime migrated from Cloudflare Workers/D1 to **Bun standalone + SQLite** (commit 3315ca8; see AGENTS.md for the current stack). The design decisions recorded below remain valid — where they mention "D1 batch", "Worker", or "Cron Trigger", the current equivalents are: SQLite transactions (`server/db/database.ts` `batch()` helper), the Bun HTTP server (`server/entry.ts`), and a boot/timer prune task. Historical findings are preserved as-is.

---

## 🔴 BLOCKERS — must fix before coding

### 1. Circular dependency: TaskService ↔ GitHubService
**Doc:** LAYERS.md  
TaskService depends on GitHubService, GitHubService depends on TaskService. Layer.mergeAll will crash at startup.

**Fix:** Move the Lexa→GitHub orchestration up to the route layer. TaskService.move() stops calling GitHubService. TasksRoute calls `taskService.move(...)` then `githubService.syncIssueState(...)` itself. The webhook direction (GitHub→Lexa) remains as-is.

### 2. GitHub sync echo loop + zero webhook idempotency
**Doc:** LAYERS.md GitHubService, ARCHITECTURE.md  
Moving a task to Done → sync closes issue → webhook fires → tries to move task (already in Done) → fails WIP limit → 500 retry storm. GitHub webhooks are at-least-once, no dedup exists.

**Fix (all 4):**
1. Store `github_synced_state TEXT` on tasks — compare payload state to stored; equal → echo → skip
2. `move()` early-returns when `task.columnId === targetColumnId`
3. Webhook moves bypass WIP limits and policies (log-and-skip)
4. Ack webhook immediately, dedup on `X-GitHub-Delivery` via small `webhook_events` table

### 3. Fractional index is broken three ways
**Doc:** SCHEMA.md, LAYERS.md  
- Algorithm: appending "V" fails when neighbors are `a0` and `a0V` — produces duplicates
- Moves don't reassign position — cards land with old column's position
- Create is read-then-write racy — two concurrent creates get same position

**Fix:** Use `fractional-indexing` npm package (Workers-safe, ~2KB). Add `UNIQUE(column_id, position)`. Move must compute new position in target column.

### 4. Human auth is named but not designed
**Doc:** ARCHITECTURE.md, SCHEMA.md, LAYERS.md  
GitHub OAuth is mentioned but: no auth routes exist, no session table, no OAuth flow handler, no authorization rules, no CSRF posture.

**Fix:** Put deployment behind **Cloudflare Access** and read `Cf-Access-Authenticated-User-Email` header. Zero auth code. Ideal for self-hosted 2-5 person tool.

### 5. Column policies are unenforceable
**Doc:** ARCHITECTURE.md, LAYERS.md  
- `restrict_roles` — no role concept exists anywhere
- `min_time` — no `column_entered_at` timestamp on tasks
- `required_fields` — `'{}'` empty TipTap doc is truthy, so required description never fails

**Fix:** Cut `restrict_roles` and `min_time` (YAGNI for 2-5 people). Fix `required_fields` with proper TipTap emptiness check.

---

## 🟡 SHOULD-FIX — 14 items

| # | Issue | Doc |
|---|-------|-----|
| 1 | WIP-limit check-then-act race — use atomic D1 batch | LAYERS.md |
| 2 | Move API split into two non-atomic calls (column + position) | LAYERS.md + API |
| 3 | Hardcoded "done"/"todo" column names break on rename | LAYERS.md |
| 4 | Webhook signature verification underspecified | LAYERS.md |
| 5 | GitHub App scope undefined — pin to Issues r/w + Metadata | ARCHITECTURE.md |
| 6 | No Conflict errors for UNIQUE violations → 500s | SCHEMA.md, LAYERS.md |
| 7 | Cross-project reference validation incomplete (swimlane, parent, labels) | LAYERS.md |
| 8 | createLinkedIssue has no already-linked guard; github_issue_id not UNIQUE | LAYERS.md, SCHEMA.md |
| 9 | search_wiki has no FTS table backing it | ARCHITECTURE.md, SCHEMA.md |
| 10 | No pagination on list endpoints or MCP tools | ARCHITECTURE.md |
| 11 | D1 read-your-writes — refetch after move can hit stale replica | SCHEMA.md |
| 12 | Ghost feature: CommentThread in component tree, no schema | ARCHITECTURE.md |
| 13 | last_used_at write on every MCP request — hot-path D1 write | LAYERS.md |
| 14 | API key format unspecified; SHA-256 with high-entropy keys is sound but must be enforced | LAYERS.md |

---

## 🟢 CONSIDER — 13 YAGNI simplifications

| # | Simplification | Impact |
|---|---------------|--------|
| 1 | Cut Labels entirely | -2 tables, -3 routes, -1 service, -2 MCP tools |
| 2 | Cut subtasks (parent_id) — **restored 2026-08-01** | Was "undefined semantics, UX cost". Now first-class via `task_links(relation='subtask_of')` with defined semantics (column inheritance, move cascade, cycle guard). See SCHEMA.md. |
| 3 | Cut restrict_roles + min_time (see 🔴 #5) | PolicyService collapses into TaskService |
| 4 | Cloudflare Access instead of GitHub OAuth (see 🔴 #4) | Deletes most security-sensitive code |
| 5 | Use @effect/platform HttpApi for routes | Auto-generates HTTP mapping + OpenAPI |
| 6 | Doc-code corrections — 4 syntax errors + Layer.mergeAll misuse | LAYERS.md |
| 7 | updated_at never maintained — pick app-level or triggers | All docs |
| 8 | UNIQUE(project_id, position) on columns/swimlanes makes reorder painful | SCHEMA.md |
| 9 | Index consolidation — one compound index replaces two | SCHEMA.md |
| 10 | wiki_pages ON DELETE SET NULL re-roots children — pick CASCADE or RESTRICT | SCHEMA.md |
| 11 | Specify MCP transport and auth header format | ARCHITECTURE.md |
| 12 | Spike TanStack Start on Workers early (Phase 1, not Phase 3) | ARCHITECTURE.md |
| 13 | File-structure gaps: missing api-key.repo.ts, auth routes | ARCHITECTURE.md |

---

## Bottom Line

Fix the **circular dependency**, **sync echo suppression**, and **fractional index** before writing code — all three are cheap decisions now, expensive archaeology later. Decide the human-auth story (strongly recommend Cloudflare Access). Then cut labels/subtasks/two-of-three-policies and the design is genuinely minimal for its requirements.

---

# Round 2 — Verification (oracle, kimi-k3, session ora-1)

v2 docs verified against round-1 findings. Verdicts: blockers 1, 2, 5 ✅ VERIFIED; blocker 4 ✅ as a decision (but deployment holes found); blocker 3 ❌ NOT VERIFIED (the specified algorithms were still wrong). The v2 fixes also leaked defects into adjacent flows. All fixed in v2.1:

## New blockers (fixed)

- **A. WIP conditional UPDATE false-failed on within-column reorders at limit** — the moving task counted itself; pure reorders in an at-limit column returned `WipLimitExceeded`. Fixed: `column_id = ?2` short-circuit in the WHERE clause (SCHEMA.md).
- **B. Position generation broken in three places** — (1) deterministic keygen meant the create-retry regenerated the *identical* conflicting key; (2) neighborless moves produced `generateKeyBetween(null,null)` = `"a0"`, colliding with the first task in any non-empty column — exactly the webhook-move path; (3) move had no retry path at all. Fixed: re-read-then-regenerate discipline for create AND move, retry only on `isPositionConflict`, neighborless moves default to append-to-end, neighbors validated against the target column (LAYERS.md, SCHEMA.md).
- **C. Cloudflare Access integration had two holes** — the `workers.dev` route bypasses Access entirely (forgeable identity header), and machine endpoints (`/mcp`, `/api/webhooks/*`) can't do Access's browser flow. Fixed: disable workers.dev + verify `Cf-Access-Jwt-Assertion` JWT, Access bypass policies for machine routes (ARCHITECTURE.md).

## Should-fix (all applied)

1. Webhook delivery recorded **after** successful processing (was: before → silent event loss on mid-processing failure); handlers confirmed idempotent
2. Swimlane semantics: omitted = keep current, explicit `null` = clear
3. `GET /api/projects/:slug/board` — unpaginated full board snapshot (pagination made 201+ task projects unrenderable)
4. `required_fields` enforced on create/update too (was: move-only)
5. `task.github_repo` ("owner/name") stored at link time — never parsed from html_url, never assumed = project repo
6. Installation-token cache moved to module/isolate scope (per-request layer would mint per call)
7. Webhook trust boundary documented as an explicit decision (repo triagers can move cards)
8. Move neighbors validated against target column (`NeighborNotInColumn` 422)
9. Out-of-sync surfacing: UI compares `github_synced_state` vs column's `github_state`; no retry queue

## Consider items applied

- Count/last-key queries include `project_id` so `idx_tasks_board` applies
- `ColumnNotEmpty` renamed `HasChildren` (shared by column + wiki-parent deletes)
- `issues.opened` subscription dropped
- `generateKeyAfter`/`generateKeyBefore` documented as `generateKeyBetween` wrappers (not library exports)
- Wiki slug conflicts reuse `SlugTaken`

**Status: design is implementation-ready pending your sign-off.**
