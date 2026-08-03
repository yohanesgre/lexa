# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

User-facing notes per release: `docs/RELEASE_NOTES.md`.

## [Unreleased]

## [0.1.0] - 2026-08-04

First release. Self-hosted PM tool for small game-dev teams: kanban, wiki,
AI writing assistant, MCP server for agents, and two-way GitHub issue sync.

### Added

- **Kanban board** — swimlanes, atomic WIP limits, required-field gates,
  drag-and-drop with stable fractional-index ordering, task archive/restore,
  per-project priority/type labels, task links (subtasks / blocked-by / related)
- **Tasks** — TipTap rich-text descriptions, assignees, GitHub issue
  link/unlink with live Synced/Diverged status
- **Wiki** — nested pages, FTS5 full-text search, revisions with restore,
  Markdown ↔ rich-text conversion
- **Forge (AI writing assistant)** — agents (rule bundles) + skills,
  pluggable runtimes (OpenCode / Hermes / Command Code), control panel
- **GitHub two-way sync** — GitHub App client, webhook route (HMAC-verified,
  echo-suppressed, delivery dedup), column ↔ issue-state mapping, multi-issue
  links, out-of-sync surfacing
- **MCP server** — 35 tools for agents (projects, tasks, wiki, GitHub links),
  API-key auth, project-scoped authorization
- **`lexa-cli`** — operator CLI (tasks, wiki, projects, Forge machine/daemon)
- **Auth** — Cloudflare Access for humans, `lxk_` API keys for machines,
  admin/member roles, API key management
- **Ops** — first-run setup wizard (CLI + web), single-process deployment
  (SSR + REST + MCP + webhooks) behind a cloudflared tunnel, SQLite WAL

### Fixed

- **bun:sqlite constraint classification** — `run()`/`batch()` now detect
  `UNIQUE constraint failed:` (bun never emits the literal `SQLITE_CONSTRAINT`),
  restoring 409 `SLUG_TAKEN` / `HAS_CHILDREN` / `OPTION_IN_USE` and the
  fractional-index `isPositionConflict` retry (previously all surfaced as 500)
- **GitHub App JWT signing** — PKCS#1 keys (GitHub's actual format) normalized
  to PKCS#8 before Web Crypto `importKey`
- **Webhook event matching** — `X-GitHub-Event: issues` + `payload.action`
  composition (compound `issues.closed` header values never arrive from GitHub)

### Notes

- Migration history squashed into a single clean `0001_init.sql` (unreleased
  squash) — fresh installs only; pre-release DBs continue to boot unmodified
- Full verification ledger: `docs/RELEASE.md`
