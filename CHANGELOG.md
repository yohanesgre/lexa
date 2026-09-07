# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Calendar Versioning](https://calver.org/) (`YYYY.MINOR.MICRO` — see
`docs/RELEASING.md`).

## [Unreleased]

## [2026.2.7] - 2026-09-08

### Fixed

- **Workers migrations failed on a fresh D1 with `FOREIGN KEY constraint
  failed`** — wrangler's `d1 execute --file` routes through D1's import
  endpoint, which rejected the baseline migration even though the same file
  passes on the D1 engine locally (workerd, FKs enforced) and plain SQLite;
  migrations now execute through the D1 query REST API as one batch (the
  path `runMigrationsD1` uses for CLI deploys), with structured errors

## [2026.2.6] - 2026-09-08

### Fixed

- **Workers `--reset-db` could never drop an existing D1** — the D1 list API
  returns `uuid` per row (not `id`), so the DELETE URL was built with
  `undefined` and CF rejected it (`Invalid uuid`); reuse path returns the
  uuid now too (#34)

## [2026.2.5] - 2026-09-08

### Fixed

- **Workers confirmations read stdin (EOF under `curl | bash`)** — Bun's
  `prompt()` got the piped script as stdin, returned instantly, and the D1
  drop question auto-answered before the operator could respond, continuing
  against a stale half-provisioned database. Confirmations now read from
  `/dev/tty`; an unreachable terminal counts as "keep" (#32)

## [2026.2.4] - 2026-09-08

### Added

- **Workers `--reset-db`** — drops the existing D1 database (matching the
  flavor name) and applies migrations fresh; interactive runs are prompted
  (y/N, default keep) when an existing database is detected, headless runs
  require the explicit flag (#30)

### Fixed

- **Workers deploy: `wrangler` spawned via `bunx`, which no longer exists**
  — recent bun removed the `bunx` shim; `spawnSync("bunx", …)` failed with
  ENOENT, surfacing as `D1 journal init failed (status 1)` with empty
  pipes and zero clue. Wrangler now runs via `bun x` and spawn errors land
  in the stderr tail (#29)

## [2026.2.3] - 2026-09-08

### Fixed

- **Workers deploy: wrangler never got the CF token** — the REST calls
  authenticated fine but `d1`/`deploy` steps spawned `bunx wrangler` with a
  bare environment, which prompted for login and failed instantly
  (`D1 journal init failed (status 1)`, stderr swallowed). The token now
  flows through the environment, captured stderr tails surface in error
  messages, and the deploy config carries `account_id`
- **Re-running a failed workers install crashed at unpack** — leftover
  tarballs from older tags made the `lexa-workers-*.tar.gz` glob match
  twice and tar treated the second as an archive member; the newest tarball
  is now extracted explicitly and stale extractions are cleaned first
- Interactive installs now **ask the flavor** (staging default); previously
  `--flavor` was flag-only and every interactive run silently deployed
  staging (#26)

## [2026.2.2] - 2026-09-08

### Fixed

- **Workers install crashed provisioning R2** — CF's `list buckets` API
  wraps the array in `result.buckets`; the installer treated it as a bare
  array and died with `TypeError: .some is not a function` right after D1
  creation. Also: KV namespaces are now matched by title instead of reusing
  the account's first namespace

## [2026.2.1] - 2026-09-08

### Fixed

- **Workers/bare deploys failed right after the release download** — the
  tarball was fetched but never extracted (`unpack_release` existed but was
  never called), so workers deploy died with `Module not found
  "scripts/workers-install.ts"`; both targets now unpack into their work dir
- **Server tarball had no `package.json`/`bun.lock`** — bare deploys could
  not resolve dependencies even after unpacking; the release tarball now
  ships both and bare deploy runs a production `bun install`
- **Bare deploy wrote no `DATABASE_PATH`** — the entry's default is
  `/app/data/lexa.db` (docker-biased) and failed with `EACCES` on a bare
  host; the deploy `.env` now points it at `<install-dir>/data/lexa.db`

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
