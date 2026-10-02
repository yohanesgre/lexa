# Changelog

All notable changes to Lexa are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Calendar Versioning](https://calver.org/) (`YYYY.MINOR.MICRO` — see
`docs/RELEASING.md`).

## [Unreleased]

## [2026.6.1] - 2026-10-02

### Added

- **Favicon and Workers static assets** — the Workers flavor serves a real
  favicon and binds the `ASSETS` binding so static files are delivered by the
  asset handler instead of the Worker, with the shell fast path taking the
  shortcut. (#224, #227)

### Fixed

- **Device-login requests pruned on schedule** — device-login requests now
  expire on the scheduled sweep instead of accumulating. (#223)
- **Remaining D1 read-modify-write paths made atomic** — the follow-up pass on
  the `DbDriver.batch` work: the mutations that read state and then wrote in
  separate statements now compute one pre-computed batch from a single read,
  so a concurrent writer can no longer interleave and cause partial or lost
  updates. The attachment dedupe race is settled by the existing
  `UNIQUE(project_id, sha256)` key, and a lost-race false 404 on assistant
  terminal transitions is gone. Bun keeps real isolation for the two
  cycle-guard sites. No new migrations — `0018` is still the latest. (#228)

## [2026.6.0] - 2026-10-02

### Added

- **Assistant write-tool permission modes** — a per-thread mode (`ask` |
  `auto` | `deny`) sticky in Durable Object `thread_meta`, with a Writes mode
  picker in the chat rail (Ask / Auto / Blocked) and backend execution paths
  for each mode plus a per-mode budget (ask: Worker pending-row cap, auto: DO
  counter, deny: none). Documented in `docs/LAYERS.md`. (#204, #205, #206)
- **Assistant Workers rework P4b/P4c/P5/P6** — chat transport moves to the
  agent WebSocket (`useAgentChat` + UIMessage adapter with
  reconnect/resume), an approval pending-batch carrier persists with assistant
  messages idempotently, Bun is removed from the assistant API surface
  (`assistant-contracts.ts` / `assistant-*` split with an API/docs sweep), and
  P6 hardening applies D7 gateway metadata-only logging
  (`cf-aig-collect-log-payload` false by default). (#198, #199, #200, #201)
- **In-app GitHub App connect** — admins create and configure the GitHub App
  from Settings via the manifest flow, with no env secrets: the manifest +
  single-use 10-minute state endpoints, a setup exchange that stores app id,
  private key, webhook secret and slug ENCRYPTED in the new
  `github_app_secrets` table (migration 0017), encrypted-first resolution with
  legacy plaintext fallback, and a Settings connect card with all five
  callback states. Manual PUT remains the last-explicit-write fallback. (#194,
  #197)
- **Chat attachments** — images and documents attach in chat: a dedicated
  `chat_attachments` table bound to the thread (migration 0015), upload/list/
  serve/delete endpoints with caps (≤3 per message, 5 MB/file, 10 MB total),
  server-side mime sniffing, PDF text extraction via unpdf with a per-document
  prompt cap, and a composer picker with chips, a caps meter, and named error
  rows. Images stay vision-gated; documents do not. (#191, #193)
- **Tasks bulk actions** — a transactional `POST /projects/:slug/tasks/bulk`
  endpoint (move/update/archive/restore in one transaction, per-item
  reporting, best-effort GitHub sync after commit) plus the Tasks page row
  selection, bulk action bar, and header "New task" control with an opt-in
  create swimlane. Kill switch `LXK_DISABLE_TASKS_BULK`. (#190, #192)

### Changed

- **Session cookieCache with a derived signing secret** — the `cookieCache`
  block moved under `session`, so session requests no longer hit D1 on every
  call. Its signing secret is now derived from `LXK_SECRETS_MASTER_KEY` and
  **fails closed when missing** (the library default was forgeable), and the
  middleware re-reads `users.role` per session request instead of trusting the
  role snapshot baked into the cookie at issue time. **Deploy note:**
  `LXK_SECRETS_MASTER_KEY` is now required on every target, and existing
  sessions invalidate once on rollout. (#215)
- **D1 atomic multi-statement writes** — `withTx` was a no-op on D1 (no
  BEGIN/ROLLBACK) while the docs claimed atomicity. `DbDriver.batch` now
  returns positional results, 26 write-only `withTx` sites became pre-computed
  atomic batches, and the emission-invariant scanner accepts `batch` too.
  Migration `0018` enforces **one role per (user, project)**, de-duplicating
  while keeping admin. (#219)
- **Remaining read-modify-write paths made atomic** — assistant-thread appends
  are a single-statement `json_insert` (truncate is a length compare-and-swap
  with bounded retry), task create no longer burns ticket numbers on a failed
  insert, swimlane/milestone archive cascades are set-based atomic SQL that
  still emit one activity row per task, bulk task operations are per-item
  atomic and report per item, and project-memory / assistant-models reorders
  are batched. A docs truth pass realigned SCHEMA, ARCHITECTURE, LAYERS, API
  and CLOUDFLARE_WORKERS with the implemented semantics. (#220)
- **`prosemirror-view` deduped** — the lockfile carried six on-disk copies
  (1.42.3 plus five nested 1.42.2), ~440 KB of dead weight in the Workers
  bundle. All consumers accept `^1.42.x`, so an override pins 1.42.3. (#211)
- **Assistant documentation reframed (ADR-0003)** — the assistant is
  Workers-only and the self-hosted deploy targets are frozen; the authority
  docs were rewritten to match. (#182)
- **Assistant API is Workers-only** — the Durable Object is the real engine
  (P1 groundwork, P2 threads + legacy TanStack→UIMessage import, P3 engine
  parity with `x-opencode-session` parity and a provider-config route). (#183,
  #185, #195)

### Fixed

- **Toggle ARIA convention** — app toggles carried state-varying accessible
  names, `role="switch"`/`aria-checked`, or no `aria-pressed`. The merged
  wireframe convention pins a constant name equal to the visible label with
  state expressed only in `aria-pressed`; the theme toggle and the setup
  password toggle were transcribed to it. Wireframes first, then app. (#214,
  #216, #217, #218)
- **Invite tokens validated before the form renders** — a spent invite link
  still rendered a live registration form, because the page gated only on
  token presence while the accept endpoint enforces single use. A new peek
  endpoint returns `{ valid, email? }` with a per-reason copy and a retry
  state. (#188)
- **Chat retry/regenerate index and thread restore** — retry resolved the
  trigger in display space but truncated the stored thread by raw index, so
  an optimistic trigger no-opped and a stale transcript dropped previously
  sent prompts; resolution now happens in raw space with a floor-bound
  duplicate-text fallback. Re-entering chat without `?thread=` restores the
  last active thread from `lexa-chat-last` and re-attaches a live run. (#187)
- **Assistant thread load on a missing row** — the typed `RowNotFound`
  surfaced as a `FiberFailureImpl` wrapper at the `Effect.runPromise`
  boundary, so a first message in a new chat 500'd on the Workers flavor.
  Handled inside Effect with `catchTag`. (#209)
- **Write-tools settings list truncation** — the settings section hardcoded a
  13-name array while the server registered 19; hydration filtered stored
  settings through it and Save wrote the filtered set back, silently
  truncating a stored 19-name selection (six destructive tools could never be
  enabled). The canonical list now lives in `shared/assistant.ts` and is
  re-exported from the server, so the UI and the server read one source. (#212)
- **Write-tools settings copy** — the section described the pre-modes contract
  (universal per-change approval, no auto-approve) and the toggle's aria-label
  drifted from the wireframe; both now match the Writes modes contract. (#213)
- **Dashboard cache on project create** — Home read `["dashboard"]` while the
  create mutation wrote only `["projects"]`, so a new project needed a manual
  refresh. The fresh `ProjectHealth` entry is synthesized into
  `["dashboard"]` from the mutation response. (#184)

### Performance

- **Dashboard counts batched, settings cached** — Workers telemetry showed one
  count query per column per project and settings checks re-reading D1 on every
  request. Column counts collapse into a single `GROUP BY` per project, and
  settings reads cache for 30s with same-process write invalidation. (#203)
- **Project access batched, Workers runtime memoized** — the projects list ran
  per-project authz (up to 4 queries each) plus one repos query per project,
  the board ran seven serial queries, and the Workers entry rebuilt D1 layers
  and better-auth every request. Authz and repos reads batch with D1
  100-param chunking and deterministic grant ordering, board reads run
  concurrently, and layers memoize per-isolate by env fingerprint. (#207)

### Migration notes

- `0018_user_project_roles_unique.sql` applies on deploy and enforces one role
  per (user, project), keeping `admin` when duplicates exist.
- `LXK_SECRETS_MASTER_KEY` is now required to boot; sessions invalidate once
  because the cookie signing secret is derived from it.
- D1 multi-statement writes are atomic again; per-item bulk results are now
  reported instead of a single set-based outcome.

## [2026.5.6] - 2026-10-01

### Fixed

- **Session listing and revocation 500 on Workers** — `/api/sessions` returned
  a 500 on Cloudflare Workers deployments. The sessions handlers imported the
  Bun better-auth singleton, which cannot run on workerd: the module has no
  `process.env` and `bun:sqlite` is a throwing shim, so importing it took down
  every handler in the graph. `listSessions` and `revokeSession` now resolve
  through the `ApiAuthHooks` tag — the Bun host wires the process-wide
  singleton, the Workers factory wires its per-request `createAuth(env)`
  instance (D1 adapter). (#178)

## [2026.5.5] - 2026-10-01

### Added

- **Persisted Workers observability by default** — the `wrangler.jsonc`
  observability block now spells out Workers Logs, Traces, and Issues with
  `persist: true` and 100% head sampling, so a Workers deployment gets durable
  logs and traces without a manual config edit. (#176)
- **Installer transcribes the root `wrangler.jsonc`** — the per-deploy config
  the Workers installer generates hardcoded observability to the bare
  `enabled` flag and silently dropped the rest of the root block. The root file
  is now the single source: `scripts/workers-install.ts` reads it once for both
  `compatibility_date` and observability, so an installer-provisioned Worker
  matches a hand-written one. (#176)

### Fixed

- **Query strings redacted from Workers telemetry** —
  `redact_query_string: true`, so invite and set-password tokens carried in
  URLs never persist into logs, traces, or issues. (#176)
- **Installer JSONC parsing hardened** — the comment-strip regex mis-parsed
  string values containing `//`, block comments, and trailing commas. The
  parser is now string-aware, and a parse failure refuses through `die` naming
  the offending file instead of crashing. (#176)

## [2026.5.4] - 2026-10-01

### Fixed

- **Device login key delivery** — an approval could succeed in the web app
  while the CLI still saw "Login request expired": the raw key transited a
  per-isolate in-memory store, so an approve and the CLI's next poll could
  land on different Workers isolates. The key is now minted on the CLI's first
  poll after approval (the request row is atomically consumed), which is
  isolate-independent and leaves no orphan keys; a null-approver row is
  refused before consumption. (#174)

## [2026.5.3] - 2026-10-01

### Fixed

- **Installer resume metadata** — the retry-safety wipe deleted the whole
  work directory on a failed run, including the `deploy-<name>/` folder whose
  wrangler config records the domain and account the next run resumes from.
  The wipe now keeps the deploy directories (`prune_workdir`) and still
  removes stale extractions. (#172)
- **Alias installs target the right Worker** — with the deprecated
  `--name prod`/`staging` aliases, the secret put/list and `LXK_API_KEY` prune
  commands targeted the alias name instead of the deployed Worker
  (`lexa`/`lexa-staging`). Every such command now resolves the Worker name from
  the deploy config, falling back to the alias map. (#172)
- **Login refresh hint** — a stored `wrangler login` token that could not be
  verified only offered entering a token; the installer now also points at
  `wrangler whoami` to refresh the login. (#172)

## [2026.5.2] - 2026-10-01

### Fixed

- **Workers installer account selection** — a Cloudflare login that covers
  several accounts could deploy to the wrong one (the installer blindly took
  the first account listed) and provision a stray database before failing.
  The account is now resolved deterministically — `--account <id>`,
  `CLOUDFLARE_ACCOUNT_ID`, the account recorded by the previous deploy (a
  re-run keeps its account), or a single account on the token. Several
  accounts prompt on a terminal and refuse headless with the account ids
  named; a stale explicit id refuses with guidance. Resolution completes
  before anything is created, so a refusal leaves no resources behind, and
  the account listing follows pagination. (#170)

## [2026.5.1] - 2026-10-01

### Fixed

- **Session listing after 24h** — better-auth gates its core list-sessions
  call behind a fresh-session window (24h by default), so Settings → Sessions
  could neither list nor revoke for any sign-in older than a day. The gate is
  now off (its documented off-switch), blank auth 500s keep their underlying
  cause, and a >24h regression test pins the behavior. (#167)
- **Workers installer database selection** — Cloudflare's `?name=` D1 filter is
  fuzzy, so `lexa` matched `lexa-prod`, and the installer acted on the first
  listed database: a redeploy could bind a differently-named database, and
  `--reset-db` could drop every listed database. Selection is now
  client-side deterministic — an exact deploy name, otherwise a single
  `<name>-`-prefixed database, otherwise a refusal with guidance instead of a
  guess — and reset drops only the resolved database. The listing also
  follows Cloudflare pagination, so a database past the first page is no
  longer invisible. (#168)
- **Installer dry-run purity** — a workers dry run no longer mints the master
  key or writes `cf-workers/.env.toml`; it prints the mint plan and a
  placeholder put only. The real mint path (0600 custody, 32-byte key, never
  rotated) is covered by tests. (#168)

## [2026.5.0] - 2026-10-01

### Added

- **Installer rewritten as one script, three targets** — `docker` (compose file
  plus prebuilt image), `bare` (release tarball with an optional systemd unit),
  and `workers` (D1 + R2 + KV, migrations, and the prebuilt Worker bundle).
  Prerequisites are checked per target before any download or mutation: one
  pass collects every missing tool and stops with a single list (tool → exact
  fix command), so nothing is installed for you.
- **Self-describing install dirs** — each target installs into a named folder
  in the current directory: `dockers/`, `bare/`, `cf-workers/`.
- **End-to-end Workers install** — Cloudflare authentication falls back to a
  stored `wrangler login` token (silent read, verified once) before any pasted
  token. The master key is minted once and kept in `cf-workers/.env.toml`
  (0600) custody, pushed as a Worker secret without echoing it, and never
  rotated on re-run — custody first, then remote presence, then mint, and a
  presence check that cannot run mints nothing and leaves the key untouched.
- **Optional secrets at install time** — `--secrets-file <path>` applies
  `KEY=value` lines validated against the installer whitelist; without it, an
  interactive install offers a fail-closed GitHub-sync wizard (a partial trio
  is skipped with a warning, never written half-way). Re-runs preserve
  operator keys and secrets.

### Changed

- **Docker snapshot installs** — `--no-pull` skips the image pull and requires
  an image already present locally (build one with `docker build -t
  ghcr.io/yohanesgre/lexa:dev .`, then `scripts/install.sh docker --image dev
  --no-pull`). No main snapshot image is published; stable installs keep the
  default `:latest`.
- **Dead `LXK_API_KEY` Worker secret is auto-pruned** after a successful
  Workers deploy — best-effort (a failure warns and continues), the dry run
  prints the plan instead of deleting, and only that secret is ever named.
  Docker and bare drop it through the env migration.
- **Installer prompts and output** are rewritten for operator clarity —
  plainer prompts, named steps, and a final banner that reports where the
  master key and GitHub credentials live.

### Removed

- **The staging image** — `docker-compose.staging.yml` is deleted and no
  `staging` tag is published; build `dev` locally for snapshots.
- **The `dev` install target** — development starts from a clone.

## [2026.4.0] - 2026-09-30

### Added

- **Assistant chat deck** — the `/chat` surface opens a new-chat landing by
  default, with a message queue, a composer docked inside the deck, landing
  and bubbles at the full docked width, and a thread-led header carrying
  inline rename plus thread actions.
- **Skills and wider `@` mentions** — `$skill` mentions invoke a skill
  (<=3 per message), the skill catalog and `get_skill` are exposed, and `@`
  now widens to milestones, swimlanes and columns alongside tasks and wiki
  pages.
- **Secrets management** — provider keys and MCP client tokens are managed in
  the app and envelope-encrypted at rest; the keyring was generalized with a
  hard env rename, a DB-managed Jev registry with SDK transport, and an
  advisory layer for remote-only MCP clients. MCP servers ship with a Jev
  default and managed tokens only.
- **Assistant control panel** — `/admin/assistant` for provider and runtime
  configuration; the agent-runtime (Hearth/Blacksmith) tier was removed.
- **Approval carousel** — batches auto-advance, back-navigation is fixed,
  "Reject all" is supported, decisions persist, and archive/delete prompts
  accept bulk task refs.
- **Wiki navigation** — the right sidebar is replaced by an outline pill plus
  page settings, sidebar collapse is unified with mobile overlays, and the
  edit view aligns its title and preview.
- **Server-rendered share pages** — public share links render on the server
  instead of the browser, so crawlers and link unfurls get their metadata and
  the document is no longer empty without JavaScript. Authenticated routes
  stay client-only.

### Changed

- Renamed Herald to Assistant across the server API, database namespace, and documentation. Migration `0006_assistant_rename.sql` migrates data without compatibility aliases; old `/api/herald/*` clients now receive 404.
- **Structured env file (`.env.toml`)** — the flat `.env` is replaced by a
  canonical `.env.toml` (TOML; sections are presentation only, every leaf key
  is the env-var name verbatim). Precedence is **real environment →
  `.env.toml` → legacy `.env` → defaults**, and the loader never overwrites an
  already-set variable. `bun run setup` writes/merges `.env.toml` (0600) and
  auto-migrates an existing `.env`, renaming the original to `.env.legacy`
  (0600; rollback is `rm .env.toml && mv .env.legacy .env`). A flat `.env`
  still boots for one release. Tracked template is `.env.toml.example`
  (`.env.example` removed). The docker/systemd installer switch to `.env.toml`
  lands in a follow-up; containers keep working because compose still
  interpolates the flat `.env` into the container environment (bare uses
  `bun --env-file=.env`).

### Fixed

- **Mention autocomplete ordering** — tasks sharing an `updated_at` could come
  back in arbitrary order; task hits now break ties by ticket number.
- **Installer release resolution** — the app installer used GitHub's
  `releases/latest`, which can point at a CLI release (`cli-v*`) published
  after the newest app tag; it now resolves the newest `v*` app release.
- **Approval flow** — decided approval chips stay terminal instead of
  re-arming after a transcript rebuild, approval resume runs the pending
  `create_task`, and confirmation questions are kept inside the write guard.
- **New threads** — the first user bubble renders in a new chat; a
  deterministic fresh-thread 404 keeps optimistic turns and re-fetches once
  after ingress.
- **Tool-call logs** — tool names are sanitized and raw payloads are
  boundary-filtered before `streamObject`, with display logs renamed to
  `toolLog` so a provider-boundary collision cannot blank the log.
- **API and search hardening** — ticket-key aliases are accepted in task
  payloads, client-IP handling is hardened, multi-assignee search results are
  deduped, cross-project access gaps are closed, and organization delete is
  blocked while runtimes are bound.
- **Wiki edit view** — the title blends into the editor and the preview is
  aligned.
- **Bare `@` suggestions** — an empty mention query returned empty arrays, so
  the popup rendered "No matches" on a bare `@`. It now serves the 8 most
  recently updated live tasks, with wiki pages filling the remainder.

## [2026.3.0] - 2026-09-11

### Added

- **Full-page task view** — tasks expand from the board slideover into their
  own route (`/$slug/tasks/$taskId`), sharing the slideover's layout and
  actions.
- **Wiki-style editor for task descriptions** — the TipTap rich-text editor
  (same surface as the wiki) now backs task descriptions in both the
  slideover and the full page.
- **Swimlane redesign** — system lanes render first, sprint lanes get
  dedicated empty states, and the page frame is narrowed to match the rest
  of the app.
- **Workspace settings tabs** — workspace settings grouped into tabs instead
  of one long scroll.
- **Herald per-1M pricing** — model prices are stored and displayed per
  1M tokens with cached read/write pricing (migration
  `0003_herald_prices_1m_cached.sql`).
- **Herald gateway health** — live per-provider health rows, backed by an
  upstream probe on the gateway health endpoint.
- **Wireframe alignment waves 1–6** — close UI gaps across board, auth,
  wiki, milestones, timeline and swimlanes, including the backend data the
  wave-4 items needed (migration `0004_ui_gaps_w4.sql`).

### Fixed

- **Wiki sidebar** — rail, scroll lock, tree state, and mobile overlay
  behavior.
- **Invite accept flow** — the invite page routes through the invite/accept
  endpoint.
- **Setup sample-data choice** — persists so dev boot respects an opt-out.
- **Device login** — route receives the request/token props it needs.
- **Herald usage** — layout overlap and the per-1M price editor.
- **Default public URL** — points at the vite frontend.
- **User menu** — removed the retired Herald Usage entry.

### Changed

- **Docs + tooling** — README install URLs point at the installer hub; the
  guided `goal` execution skill and a hardened `verify-gate` landed for
  contributors.

## [2026.2.10] - 2026-09-09

### Changed

- **Deploy flavors removed** — `staging|prod` are gone from the install
  tooling. `--ref <tag|branch>` picks `main` or a release tag, `--image`
  pins the docker image (default `latest`), `--name` keys workers resource
  names (default `lexa`; `staging|prod` stay as deprecated aliases so old
  deploys keep upgrading). `LXK_ENV=production` on all deployed targets;
  sample data is now offered in every environment.
- **Installer hub is the default install path** —
  `curl -fsSL https://install.yohanesgre.com/lexa/install.sh | bash`
  serves the newest release with `BASE_URL` pinned to its tag
  (`?ref=` pins explicitly, raw GitHub URLs still work).

### Added

- **Workers upgrades resume** — the previous domain becomes the prompt
  default, the CF token is reused (`--cf-token` > `CF_API_TOKEN` > saved
  `.cf-token`, offered after TTY entry, never written from env/flag), only
  the 2 newest tarballs are kept, and a fresh-install confirm fires when
  no previous deploy is found in the directory.
- **Post-release installer verify** — `publish.yml` / `publish-cli.yml`
  POST the warm hook and poll `X-Resolved-Tag` so a new tag is served
  immediately instead of waiting out the resolve cache.

## [2026.2.9] - 2026-09-08

### Fixed

- **Workers API rebuilt the entire stack per request** — better-auth, the
  Effect service graph, and the HttpApi web handler were constructed on
  every API call, blowing the Workers free plan's 10ms CPU budget
  (`Worker exceeded CPU time limit` on `/api/projects`). The stack is now
  built once per isolate (env-fingerprinted) — still recommended to run
  the paid plan for real workloads

## [2026.2.8] - 2026-09-08

### Fixed

- **Workers deployment served blank pages** — the workers ssr environment
  renders the SPA shell without the entry `<script type=module>` tag (the
  client manifest never queues scripts in that environment), so the served
  shell never boots the client: empty page, clean console. The SSR handler
  now re-attaches the entry script from the shell's own `$_TSR` manifest
  when absent. Not a Workers free-plan limitation — reproduced in local
  workerd with a complete, script-less response (#38)

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
