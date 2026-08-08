# v0.1.0 — Release Notes

> 2026-08-04 · Self-hosted project management for small game-dev teams.
> Kanban · Wiki · AI writing assistant · GitHub issue sync · MCP server for agents.

## What's new

**Kanban board**
- Swimlanes + WIP limits (enforced atomically — no races), required-field gates, drag-and-drop with stable fractional-index ordering
- Task archive/restore (soft-delete keeps the board clean)
- Per-project priority/type labels (colors, reorder, custom values)
- Task links: subtasks (children inherit the parent column, move cascades, cycle guard), blocked-by, related-to

**Tasks**
- Rich text descriptions (TipTap), assignees, GitHub Issues section: link/unlink issues, live Synced/Diverged status
- **Activity timeline + comments (2026-08-08):** every task change lands on an append-only timeline — moves, field changes, links, GitHub sync, Forge runs — plus Markdown-rendered comments with mention chips. Activity tab in the task slideover (Description | Activity), "Load older" keyset pagination, comment edit/delete with author-or-admin authz. Agents post comments via MCP (`add_task_comment`); mutation responses carry the appended activity rows so the timeline updates instantly.

**Wiki**
- Nested pages, full-text search (FTS5), revisions with restore, Markdown ↔ rich-text conversion
- The same editor everywhere: tasks and wiki

**Forge — AI writing assistant**
- Rewrite/Continue/Summarize/Expand/Fix grammar on any selection, with project context
- Agents (rule bundles) + skills, pluggable runtimes (OpenCode, Hermes, Command Code)
- Control panel: every Forge run across projects, live activity, results

**GitHub two-way sync**
- Create issues from tasks (multiple per task, one per repo); column ↔ issue-state mapping
- Move a task → issue closes/opens on GitHub; close on GitHub → task moves (echo-suppressed, deduped — no loops)
- Out-of-sync surfaced on the card instead of silent divergence

**For agents & automation**
- MCP server (37 tools) — agents manage projects, tasks, wiki, GitHub links, activity & comments through the same API
- `lexa-cli` for operators; API keys with admin/member roles
- Humans authenticate via Cloudflare Access (no passwords to manage)

**Ops**
- First-run setup wizard (CLI + web), sample data toggle
- Single Bun process: SSR + REST + MCP + webhooks; SQLite (WAL) — one `docker compose` deploy behind a cloudflared tunnel

## Quick start

```bash
bun run setup          # admin email, API key, migrations, optional sample data
bun run dev:full       # dev: API :3000 + frontend :5173
# prod: lexa-cli deploy <domain> prod
```

GitHub sync setup (GitHub App, webhook, Access bypass): `docs/GITHUB_SETUP.md`.

## Notes & limitations

- **Auth model:** humans = Cloudflare Access (email allowlist); machines = `lxk_` API keys. REST is Access-gated; agents use `/mcp` (bypass + key).
- **GitHub sync is best-effort by design** — no retry queue; divergence is surfaced (Diverged dot), a re-move resyncs.
- **No email notifications** — cut for v1 (small team, tight scope). Comments shipped 2026-08-08 with the activity timeline (comments live in-app; no delivery).
- **Rate limiting** — in-process per-IP limiter on `/api/*` + `/mcp` (webhook-exempt, 600 req/10 min), added post-release 2026-08-06 (see `docs/RATE_LIMITING.md`).
- **Migrations are numbered** — `0001_init.sql` … `0004_task_activity.sql`, fresh installs run all in order; existing DBs boot unmodified (no re-migration).

## Verification

`tsc` clean · 208 unit tests · production build · backend curl suite · MCP smoke + full GitHub round-trip green on production (fresh DB).
