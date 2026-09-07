# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Calendar Versioning](https://calver.org/) (`YYYY.MINOR.MICRO` — see
`docs/RELEASING.md`).

## [Unreleased]

## [2026.2.0] - 2026-09-08

### Added

- **Setup wizard seed flavors** — the sample-data step is now a three-way
  choice: **Minimal** (default — 1 starter project, 5 tasks, 1 wiki page,
  shows the core workflow), **Full** (the dev seed: 4 projects, 15 tasks,
  swimlanes, wiki tree, GitHub link examples) or **Empty**;
  `POST /api/setup/seed` takes `{ flavor: "minimal" | "full" }` and backfills
  task keys after loading (wireframe-first: setup-wizard.html)
- **Staging gets sample data** — the wizard seed previously ran in dev only
  and silently no-op'd elsewhere; staging now seeds like dev. Prod stays
  empty (`docs/API.md`, `AGENTS.md` updated)
- **Unconfigured instances funnel to the wizard** — `/login` now checks
  `/api/setup/status` and navigates fresh installs to `/setup` instead of
  showing a login form with no superadmin to sign in as

### Fixed

- **Seeded first installs deadlocked the wizard** — the sample-data step
  inserted projects, then `POST /api/setup/complete` hit the
  `projects > 0` branch of the setup lock and 403'd; the frontend swallowed
  the error, so `setup_complete` was never written and the dashboard nagged
  "Finish setup" forever. `complete` no longer counts projects (admin,
  api-key and seed keep the guard)
- **Install script deployed a broken login** — the rendered compose never
  passed `LXK_PUBLIC_URL` / `LXK_TRUSTED_ORIGINS` into the container, so the
  server fell back to `http://localhost:3000` and Better Auth rejected every
  login origin (`Invalid origin` 403s); both values are now forwarded, the
  deploy `.env` carries `LXK_TRUSTED_ORIGINS`, and local deploys trust both
  loopback hostnames (`localhost` and `127.0.0.1`)
- **Docker image was missing the seed SQL** — `scripts/seed-*.sql` were not
  copied into the runtime image, silently disabling all seeding in
  containers
- **Board kept rejected moves** — dragging a task into a column that refuses
  it (required fields, WIP limit) left the card in the target column with
  wrong counts forever; the board now awaits the mutation and on failure
  reverts from the authoritative cache and shakes the card (invalid-drop
  feedback per the design system)
- **401 retry spam from shell-mounted queries** — `AppShell` fetched the
  project list on every surface including login, and TanStack retried the
  401 three times; bare paths skip the fetch and auth failures are never
  retried
- **React #418 on every page** — six same-line spaces between `<html>` and
  `<head>` in the root route emitted a whitespace text node as a child of
  `<html>`; hydration was discarded for every visitor and the app
  re-rendered from scratch (root of the "hydration mismatch" console noise)
- `lexa-deploy/` (local compose + real keys) is gitignored

## [2026.1.3] - 2026-09-07

### Fixed

- **Piped installs (`curl \| bash`) crashed at bootstrap** — piped runs have no
  `BASH_SOURCE[0]` and `set -u` aborted before anything executed; the lib now
  bootstraps into a temp dir when piped and uses the checkout when run
  directly (`v2026.1.2` shipped this bug — found by the first real piped e2e)
- **Uninstall left the deploy dir behind** — the removal ran from inside the
  dir with a relative path (silent no-op); now resolves to an absolute path

## [2026.1.2] - 2026-09-07

### Added

- **Install script** — self-hosting entry point: `curl -fsSL …/scripts/install.sh |
  bash -s -- <target>` with targets docker (direct port mapping), bare metal
  (release tarball + start script, `--systemd` opt-in), Cloudflare Workers
  (release tarball + provisioning helper: D1/R2/KV find-or-create, D1 journal
  migrations, deploy — zero clone) and dev (clone + dev:full); `uninstall.sh`
  per target with data-kept-unless-`--purge` teardown
- **Release artifacts** — CI publishes `lexa-server-v<TAG>.tar.gz` +
  `lexa-workers-v<TAG>.tar.gz` (+ checksums) on every web release

### Fixed

- **Setup wizard was unusable** — the wizard posted `{email}` while the API
  contract requires `{email*, password*}`; step 1 now collects a password
  (min 8, show toggle), step 2 adapts to env-provided keys, Done marks setup
  complete. First-install provisioning is free-choice: `LXK_ADMIN_EMAILS`
  no longer allow-lists the wizard
- **SPA-shell auth gap** — the prerendered shell dehydrated a settled root
  match, so the auth guard (root beforeLoad) never ran on first hydration;
  anonymous visitors saw the app shell with 401-firing queries. The guard is
  now mirrored client-side after hydration

### Removed

- **`lexa-cli deploy` / `undeploy`** (ships as cli-v2026.2.0) — deployment
  moved to the install script; `lexa-cli` is purely the headless operator
  frontend with web-feature parity

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
