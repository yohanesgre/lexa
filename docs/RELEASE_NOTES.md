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
- Rich text descriptions (TipTap), assignees, comments-free by design — breakdown lives in the description
- GitHub Issues section: link/unlink issues, live Synced/Diverged status

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
- MCP server (35 tools) — agents manage projects, tasks, wiki, GitHub links through the same API
- `lexa-cli` for operators; API keys with admin/member roles
- Humans authenticate via Cloudflare Access (no passwords to manage)

**Ops**
- First-run setup wizard (CLI + web), sample data toggle
- Single Bun process: SSR + REST + MCP + webhooks; SQLite (WAL) — one `docker compose` deploy behind a cloudflared tunnel

## Quick start

```bash
bun run setup          # admin email, API key, migrations, optional sample data
bun run dev:full       # dev: API :3000 + frontend :5173
# prod: scripts/setup.sh <domain> prod
```

GitHub sync setup (GitHub App, webhook, Access bypass): `docs/GITHUB_SETUP.md`.

## Notes & limitations

- **Auth model:** humans = Cloudflare Access (email allowlist); machines = `lxk_` API keys. REST is Access-gated; agents use `/mcp` (bypass + key).
- **GitHub sync is best-effort by design** — no retry queue; divergence is surfaced (Diverged dot), a re-move resyncs.
- **No email notifications, no comments** — cut for v1 (small team, tight scope).
- **Rate limiting** not enforced in code — configure CF rate rules if you expose `/api` publicly.
- **Migrations are squashed into one clean `0001_init.sql`** — v0.1.0 installs fresh; existing pre-release DBs continue to boot unmodified (no re-migration).

## Verification

`tsc` clean · 95 unit tests · production build · backend curl suite · MCP smoke + full GitHub round-trip green on production (fresh DB).
