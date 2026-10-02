# Changelog

All notable changes to `lx` are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Calendar Versioning](https://calver.org/) (`YYYY.MINOR.MICRO` — see
`docs/RELEASING.md`).

The CLI version is INDEPENDENT of the web app version:
`cli-vYYYY.MINOR.MICRO` tags release the binary; `vYYYY.MINOR.MICRO` tags
release the app image. The version lives in `cli/package.json` —
`publish-cli.yml` verifies the tag matches it before compiling.

## [Unreleased]

## [2026.5.2] - 2026-10-03

### Changed

- **Active-host model for multiple logins** — resolution is `--url` >
  `LEXA_URL` > the active saved login, stored keys are host-scoped, `logout`
  targets the active host (with `--all` to clear every saved login), and
  `status` shows the host it resolved.

### Removed

- **`lx github --local/--env-file`** — GitHub sync is configured in the web
  app only; both flags are now hard errors.

## [2026.5.1] - 2026-10-01

### Fixed

- **`lx login` polling window** — the device-flow poll deadline now follows the
  server-reported expiry (`expiresMs`, plus a small grace; clamped; falls back
  to 5 minutes) instead of a hard-coded window, and the local-timeout message
  names the actual window. (#174)

## [2026.5.0] - 2026-09-30

### Added

- **Lifecycle writes** — `lx task delete`, `lx task update
  --description/--assignees/--due/--clear-due`, and the full `lx wiki
  create|update|delete` surface (reparent via `--parent` / `--parent-root`, and
  slug rename, which reports `old → new`).
- **GitHub issue linking** — `lx github link` (create an issue from a task and
  link it), `lx github link-existing`, and `lx github unlink`; `unlink` accepts
  either `--issue-id <nodeId>` or `--repo <owner/name> --issue <n>`.
- **Planning reads + milestone writes** — `lx column|swimlane|milestone list`
  (`column list` surfaces WIP limits, done state, and GitHub state), `lx
  milestone create|update`, and positional `lx task move --before/--after` plus
  `lx task move --clear-due`.
- **Admin surface** — `lx project|column|swimlane` create/update/delete
  (`project delete` requires `--yes`), `lx milestone create|update`,
  `lx field-config put` (`--file -` reads stdin; `field-config get` is a plain
  project read), and `lx settings rate-limit get|set` +
  `lx settings api-keys list|create|revoke`. These need a superadmin session, a
  superadmin-bound key, or a server/bare key — except `settings api-keys
  create`, which needs a user-bound admin (a bare key gets `NO_USER_CONTEXT`).

### Removed

- **machine/runtime commands** — `lx machine *` (install/listen/start/stop/
  restart/status/logs/delete/workspace) and `lx runtime *` are gone with the
  removed AI-runtime (Blacksmith) tier. `lx login` no longer registers a
  machine. The CLI is operator-only: `login|logout|status|upgrade|project|
  task|wiki|github|column|swimlane|milestone|field-config|settings`.
- **Migration** — the removed commands have no replacement; drop `lx machine *`
  and `lx runtime *` from any scripts or CI that called them. Upgrade with
  `lx upgrade` (installed binary only — it resolves the newest `cli-v*`
  release and replaces itself in place); from a source checkout run
  `bun run install:cli-dev` for a dev shim instead.

### Changed

- `lx upgrade` installs the new binary only (no listener restart hint).
  `compile:cli` is a plain `bun build --compile` — no embedded daemon or
  daemon bundle.
- External harness contract documented: read/write work items through
  `lx task …` / `lx wiki …` only; `--json`, TipTap→Markdown, `PREFIX-N`
  aliases.
- `--json` is a READ-side flag: `task`/`wiki` `list` + `get`, the planning
  `list` reads (`project`, `column`, `swimlane`, `milestone`), and
  `field-config get`. `lx settings *` takes no `--json`; writes print
  human-readable confirmations, including the wiki `old → new` slug on rename.

### Fixed

- **GitHub link envelope** — `lx github` unwraps the link envelope and the
  request timeout is bounded instead of hanging.
- **Tag parsing** — `cli-v*` tag parsing is tightened so a malformed tag can
  no longer resolve to a wrong release.
- **`lx task move`** — the task's swimlane is preserved on move and id
  resolution is delegated to the API.

## [2026.4.0] - 2026-09-11

### Changed

- CLI binary renamed `lexa-cli` → `lx`; the legacy `lexa-cli` release asset is
  published for one transition cycle, and the dev shim is now `lx-dev`.
- `install-cli.sh` adds `~/.local/bin` (or `$LEXA_CLI_DIR`) to the shell PATH
  when missing, and removes stale `lexa-cli` / `lexa-cli-dev` shims.

### Fixed

- `lx upgrade` run from a legacy `lexa-cli` binary now installs the new binary
  as `lx` and removes the old path, so the `lx` command appears after
  upgrading (it previously rewrote the legacy path in place).

## [2026.3.0] - 2026-09-09

### Added

- **`lexa-cli login <url>` device flow** — login without `--key` creates a
  pairing request, prints the verify URL, polls until approved in the
  browser, then saves the minted user-bound key (chmod 600) and registers
  the machine. Legacy `--url`/`--key` and env fallbacks unchanged; old
  servers fall back with a clear message.

### Fixed

- **Verify URL parse guard** — device-login verify URL parsing no longer
  throws unguarded on malformed input.

## [2026.2.0] - 2026-09-07

### Removed

- **deploy/undeploy commands** — deployment moved to the install script
  (`curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install.sh | bash -s -- docker|bare|workers|dev`).
  `lexa-cli` is now purely the headless operator frontend
  (login/status/task/wiki/project/members/keys/machine/runtime/github/upgrade).

## [2026.1.1] - 2026-09-07

### Fixed

- **CI hygiene** — knip configured with real entries, mobile check boots the
  dev stack with the correct seed password, unused imports cleaned

## [2026.1.0] - 2026-09-07

### Added

- **Tasks** — `task list/create/get/move/update` with Markdown descriptions
  (converted server-side), short-ID prefixes, `--json` output
- **Wiki & projects** — `wiki list/get`, project CRUD
- **Machines (Hearth runtimes)** — `machine install/listen/start/stop/
  restart/status/logs/delete`, workspace provisioning and sync
- **Deploy** — `deploy <domain> [staging|prod]` (Docker Compose +
  cloudflared tunnel, or Workers + D1 flavor), `undeploy`, `--image` pin,
  `--clean` full reset; `upgrade` self-updates the binary
- **GitHub** — `github status/setup/check` against the live server or the
  local env bootstrap
- **Auth** — `login/logout/status/version`
