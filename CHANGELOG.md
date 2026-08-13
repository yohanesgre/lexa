# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **In-app human auth (Better Auth)** — email/password login at `/login`,
  cookie sessions (7d sliding), logout, and set-password links; Better Auth
  1.6.27 runs in-process at `/api/auth/*`. No more Cloudflare Access / Google
  OAuth — no external IdP, no SMTP.
- **Teams (Better Auth orgs)** — superadmin creates/deletes teams; team
  admins (org owner/admin) manage own team's members (add workspace member
  by email, set role owner/admin/member, remove — sole-owner removal blocked
  with `SOLE_OWNER`), projects, and Forge runtimes. Projects carry an owning
  `team_id`; unassigned projects are superadmin-only until assigned.
- **Workspace members & invites** — superadmin-only surface: member list
  (role, teams, last seen), deactivate/reactivate, delete (revokes bound API
  keys), link-based invites (7d expiry, revocable while pending), and
  set-password links (single-use, 7d). `users.role` narrows to
  `superadmin | member`; superadmin is env-only (`LXK_ADMIN_EMAILS`), never
  edited at runtime (`admin_emails` setting and the `update_user_role` MCP
  tool removed).
- **Self-service sessions** — `/api/sessions` lists your sessions with
  device/IP; revoke any of them (password change revokes the others).
- **Team-scoped Forge runtimes** — runtimes belong to a team (`team_id`),
  claim only that team's project tasks; `NULL` = superadmin-owned global
  runtime that serves any team.
- **Login rate limiting** — failed logins throttled in-process (Better Auth
  rate-limit plugin, ~5 attempts/60s per email, 15 min lockout); the
  existing per-IP `/api/*` limiter is unchanged.
- **Milestones** — goal wrappers above sprints (e.g. "v1.0 launch") with an
  optional target date; each milestone holds one or more sprints. New
  `/$slug/milestones` page (list with sprint sub-rows + progress bars,
  create/edit/archive/restore, "Complete milestone" cascade), milestone
  selector on the board, read-only active-milestone card on the project
  home, and a timeline tab with a week-granular gantt (milestone ◆ due
  markers, sprint bars with done-fill, drag to reschedule).
- **Sprint swimlanes** — every non-backlog lane is now a **sprint** with
  optional start/end dates and optional milestone membership (loose sprints
  allowed); sprint headers show a progress pill (X/Y done, green + "Ready to
  archive" at 100%). New `/$slug/swimlanes` page: flat lane list with
  milestone/state filters and "View tasks" deep links.
- **Done columns** — columns gain a "Done column" flag (`columns.is_done`),
  independent of the GitHub state mapping; multiple done columns are
  allowed (e.g. Done + Released). Sprint progress counts a task as done
  when it sits in a done column or is archived.

### Changed

- **Dual-channel API auth** — `/api/*` accepts a session cookie (humans) or
  a Bearer `lxk_*` key (machines); the `x-lxk-user` header and the browser
  key injection (`VITE_LXK_API_KEY` meta tag) are removed — browser calls
  authenticate via the session cookie only. `/mcp` stays key-only.
- **Server settings are superadmin-only** — API keys, rate limits, GitHub
  sync, and Forge agents/skills now require superadmin (was `admin`).
- **Deployment** — `lexa-cli deploy` no longer provisions Cloudflare Access
  apps/IdPs and drops the `--google-client-id` / `--google-client-secret` /
  `--team-domain` / `--email-domain` flags; it writes `LXK_PUBLIC_URL`.
  `LXK_ACCESS_AUD` / `LXK_ACCESS_TEAM` are removed. The `/setup` wizard
  creates the first superadmin with a password.
- **Swimlane kinds renamed** — the old `milestone` swimlane kind is now
  `sprint`; existing milestone lanes become loose sprints on upgrade (no
  milestone, dates kept). Sprint-kind lane headers read "Sprint"; the
  Backlog remains the one permanent system lane.

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
