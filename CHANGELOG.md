# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-08-12

### Added

- **Forge warm opencode serve runtime** — each machine runtime now owns a
  persistent `opencode serve` (sealed sandbox HOME at
  `LEXA_DIR/runtimes/<id>/forge-home/`, per-flavor ports with
  `FORGE_SERVE_PORT` override) so MCP/config load happens once, not per task.
  Tasks drive the server over pure HTTP (`POST /session?directory=`,
  blocking `POST /session/:id/message`), eliminating cold starts.
- **Persistent agent sessions** — a task/wiki page keeps its conversation
  across runs: the mapping lives in the new `forge_sessions` table
  (`GET/PUT/DELETE /api/forge/sessions`, `POST /api/forge/sessions/reset`
  409s while a task runs). Agent or skill change starts a new session;
  cancel/timeout aborts the server-side session and drops the mapping; a
  serve crash respawns in 5s and sessions survive on disk.
- **Forge popover session line** — "Continuing session from <relative
  time>" (or "New session") with a **New session** button, disabled while a
  task for the document is running.

- **Project description on `/dashboard`** — the selected project's saved
  description renders as a card under the header, collapsing at 3 lines with a
  **Read more / Read less** toggle that expands in place (shown only when the
  text exceeds the limit). A settings gear next to the block opens the Project
  Settings modal, where the description is editable; saving updates the
  dashboard immediately (no refetch). Projects without a description show a
  "No description yet" placeholder. Backend support already existed
  (`PATCH /api/projects/:slug { description }`); the dashboard cache now
  reflects project updates (`["dashboard"]` + `["board", slug]` keys).

### Fixed

- **Forge review Accept replaces the document correctly** — the previous
  `insertContentAt` call passed a full `{type:"doc"}` node, which is a schema
  violation inside ProseMirror (doc inside doc): the accepted review silently
  never landed, and the invalid-content fallback could replace the document
  with an empty doc — wiping the task description. Accept now uses
  `setContent`, the canonical full-document replace.
- **Whitespace-only Forge results never reach the review** — a blank/empty
  generation can no longer be offered or accepted (previously a whitespace
  result passed the guard and could wipe the document on accept).
- **Rejected Forge reviews are not re-offered** — rejecting in the editor
  review surface records the task as terminal (`lxk.forge-rejected-task`), so
  the Forge popover no longer re-attaches to the same completed task and
  re-offers its result when reopened (mirrors the accepted-task behavior).

### Changed

- **`lexa-cli` versioning restructured** — the CLI now has its own
  `cli/package.json` (version source of truth), `cli/CHANGELOG.md`, and
  `cli/README.md`. `cli/version.ts` is static; `publish-cli.yml` verifies the
  `cli-v*` tag matches the package version. Fixes released CLIs always
  re-downloading on `upgrade` (the embedded version previously included the
  `cli-` tag prefix, breaking version comparison).

## [0.2.0] - 2026-08-11

### Added

- **Rate limiting in Settings** — per-IP budget and window configurable from
  Settings → Rate Limiting (live apply, no restart); defaults raised to 6000
  req / 10 min; Forge machine surfaces (daemon log streams, runtime
  registration, the 3s listener heartbeat) are exempt from throttling
- **GitHub sync in Settings** — App ID, private key (.pem file upload), and
  webhook secret configured from Settings → GitHub Sync with live apply;
  secrets are write-only (never returned by the API); Remove GitHub sync flow
  with confirmation
- **Forge repo content context** — agent runs on tasks with linked GitHub
  issues receive capped repo content (Contents API, ≤3 repos / 50 files /
  512 KB) as `repo-content/` in the working directory, with a MANIFEST
- **Machine setup key** — the Setup runtime wizard's machine step mints the
  `lexa-cli login` key (once-only display), closing the pre-runtime dead end

### Changed

- **Config single source of truth** — the settings DB is the runtime source
  for rate limit + GitHub credentials; environment variables are a first-boot
  bootstrap, mirrored into the DB at boot only when unset (never overwriting
  web-settings values; UI-cleared keys re-import from env at next boot)
- **Settings is an admin-only page** — hidden from members in the nav; a
  known member hitting the URL is redirected; server stays authoritative
- **Navbar active states** — Forge owns its route type; the Lexa brand is
  active only on `/`

### Fixed

- **Lexa brand wrongly highlighted on the Forge page** — `/forge` mapped to
  the home route type, activating the brand alongside the Forge link

## [0.1.1] - 2026-08-10

### Fixed

- **Docker image size** — multi-stage build (builder + lean runtime with
  production-only deps) cuts the image from 1.66GB to ~648MB (61% smaller;
  ~280MB compressed to the registry). No behavior change; verified with a
  full container smoke test (health, SSR, authenticated API round-trip).
  CLI binary size unchanged (~74MB — bun compile floor).

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
