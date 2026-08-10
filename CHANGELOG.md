# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-10

Initial release. Self-hosted project management tool: kanban with swimlanes
and WIP limits, nested wiki, Forge AI writing assistant, MCP server for
agents, and two-way GitHub issue sync.

### Added

- **Kanban board** — swimlanes, atomic WIP limits, required-field gates,
  drag-and-drop with stable fractional-index ordering, task archive/restore,
  per-project priority/type labels, task links (subtasks / blocked-by / related)
- **Tasks** — TipTap rich-text descriptions, assignees, activity timeline +
  comments, GitHub issue link/unlink with live Synced/Diverged status
- **Wiki** — nested pages, FTS5 full-text search, revisions with restore,
  Markdown ↔ rich-text conversion
- **Forge (AI writing assistant)** — agents (rule bundles) + skills,
  pluggable runtimes (OpenCode / Hermes / Command Code), control panel
- **GitHub two-way sync** — GitHub App client, webhook route (HMAC-verified,
  echo-suppressed, delivery dedup), column ↔ issue-state mapping, multi-issue
  links, out-of-sync surfacing
- **MCP server** — tools for agents (projects, tasks, wiki, GitHub links),
  API-key auth, project-scoped authorization
- **`lexa-cli`** — operator CLI (tasks, wiki, projects, Forge machine/daemon,
  deploy, upgrade, GitHub status/setup/check)
- **Auth** — Cloudflare Access for humans, `lxk_` API keys for machines,
  admin/member roles, API key management
- **Ops** — first-run setup wizard (CLI + web), single-process deployment
  (SSR + REST + MCP + webhooks) behind a cloudflared tunnel, SQLite WAL,
  rate limiting, Access JWT verification, admin-only enforcement
