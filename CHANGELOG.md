# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Calendar Versioning](https://calver.org/) (`YYYY.MINOR.MICRO` — see
`docs/RELEASING.md`).

## [Unreleased]

## [2026.1.1] - 2026-09-07

### Fixed

- **CI hygiene** — knip configured with real TanStack/router/server/CLI
  entries (previous runs flagged used files as unused), the mobile
  responsiveness check boots the dev stack instead of failing on a dead
  port, unused imports and extra non-null assertions cleaned, and
  `shared/herald` dropped its duplicate stream-alias exports
- **Docker build** — dead `VITE_LXK_API_KEY` build argument removed
  (browser auth has ridden the session cookie since 2026.1.0's auth
  switch); buildx secret-in-arg warnings gone

## [2026.1.0] - 2026-09-07

### Added

- **Kanban board** — swimlanes (one permanent Backlog plus sprint lanes
  with optional dates and milestone membership), atomic WIP limits,
  required-field gates per column, drag-and-drop with stable
  fractional-index ordering, task archive/restore, done-column flags,
  per-project priority/type labels, task links (subtasks / blocked-by /
  related), stable ticket keys (`PREFIX-n`, accepted everywhere a task id is)
- **Tasks** — TipTap rich-text descriptions, assignees, comments, activity
  timeline, file attachments, GitHub issue link/unlink with live
  Synced/Diverged status
- **Wiki** — nested pages, FTS5 full-text search, revisions with restore,
  public share links, Markdown ↔ rich-text conversion
- **Milestones & sprints** — goal wrappers above sprints with target dates,
  progress pills with "Ready to archive" state, milestone timeline with a
  week-granular gantt, swimlane management page with filters
- **Hearth (AI writing assistant)** — two builtin agents (Herald Agent for
  prose, Blacksmith Agent for code) plus custom agents and skill bundles,
  per-project execution engine, pluggable runtimes (OpenCode / Hermes /
  Command Code), machine listener with systemd unit and persistent daemon,
  persistent agent sessions per document, review flow (accept/reject),
  repo content context for linked GitHub issues, usage tracking
- **Herald (AI chat)** — streaming chat with threads and attachments,
  multi-provider gateway with fallback and health tracking, per-model
  capability inference, thinking-effort picker, proposed-actions flow
  (Herald proposes task/wiki writes, humans approve per item),
  per-project provider bindings, usage dashboard
- **Auth & teams** — email/password login with cookie sessions, teams with
  owner/admin/member roles, workspace invites and set-password links,
  self-service session list with revoke, login rate limiting
- **API auth** — dual channel: session cookie for humans, Bearer `lxk_*`
  keys for machines; configurable per-IP rate limits
- **GitHub two-way sync** — GitHub App client configured from Settings,
  HMAC-verified webhooks with echo suppression and delivery dedup,
  column ↔ issue-state mapping, multiple issues per task, out-of-sync
  surfacing, per-project repo roles
- **`lexa-cli`** — operator CLI: tasks, wiki, projects, machine/daemon
  management, deploy/undeploy, self-update, GitHub setup (see
  `cli/CHANGELOG.md`)
- **Ops** — first-run setup wizard (CLI and web), single SQLite database
  (WAL) with a squashed baseline migration, Docker Compose + cloudflared
  tunnel deployment or Cloudflare Workers + D1 flavor, staging/prod
  environments, version-pinned redeploys
