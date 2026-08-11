# Changelog

All notable changes to `lexa-cli` are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows
[Semantic Versioning](https://semver.org/).

The CLI version is INDEPENDENT of the web app version (see AGENTS.md):
`cli-vX.Y.Z` tags release the binary; `vX.Y.Z` tags release the app image.
The version lives in `cli/package.json` — `publish-cli.yml` verifies the tag
matches it before compiling.

## [Unreleased]

### Added

- **`task create --description <markdown>`** — new tasks can be created with
  a Markdown description (converted to rich text server-side).

### Fixed

- **`task get` prints the task description** — TipTap content is rendered to
  Markdown. Previously the command only showed title/id/priority/type/column/
  swimlane, so descriptions were invisible to agents and humans using the CLI.
- **`task create` / `task update` / `task move` parse the mutation envelope** —
  responses are unwrapped from `{data, activity}`. `task create` previously
  printed `Created task undefined — undefined`; `task update` printed a blank
  title.
- **Short task IDs resolve** — the 8-char prefixes shown by `task list` are
  now accepted by `task get` / `task move` / `task update` (unique prefix
  match against the project's tasks; full UUIDs unchanged).

## [0.1.8] - 2026-08-11

### Added

- **`github status` / `github setup` are remote-by-default** — they read/write
  the live server via the Settings API (login required); `--local` explicitly
  targets the `.env` bootstrap file (imported into the server DB on the next
  boot only while unset, never overwriting web Settings values). Help text
  documents both modes. `github check` unchanged.
- **`GET/PUT /api/settings/github`** client methods (`getGithubSettings`,
  `updateGithubSettings`) — used by the remote modes.

## [0.1.7] - 2026-08-11

### Added

- **`deploy` provisions Access bypass apps** for `/api/*`, `/mcp`, and
  `/api/webhooks/*` (Bypass policy, everyone) — the API key / HMAC
  signature is the machine auth; the Access layer only guards the human
  UI. Without these, `lexa-cli login` and MCP clients hit the Access
  login page instead of the API.

### Fixed

- **Clearer API errors** — a non-JSON (HTML) response now reports "is the
  host behind Cloudflare Access without an /api/* bypass policy?" instead
  of the opaque "Failed to parse JSON".
- **`bun run lexa-cli-dev`** pointed at the pre-restructure `cli/index.ts`.

## [0.1.6] - 2026-08-11

### Fixed

- **Deploy could pass the wrong API key to the container** — compose
  precedence puts shell env above `--env-file`, so a stale exported
  `LXK_API_KEY` (e.g. prod's key left in the shell when deploying
  staging) silently overrode the flavor env file, and every API call
  from the app 401'd. The deploy now strips the managed keys from the
  compose environment; only `COMPOSE_PROJECT_NAME` and an explicit
  `--image` tag pass through.

## [0.1.5] - 2026-08-10

### Changed

- **`cli/src/` layout + own `cli/package.json`** — the CLI version's single
  source of truth is now `cli/package.json` (read statically by
  `cli/src/version.ts`; no more env-embedded stub). New dedicated
  `cli/CHANGELOG.md` and `cli/README.md`. `publish-cli.yml` verifies the
  `cli-v*` tag matches the package version and publishes release notes from
  the changelog.

### Fixed

- **`upgrade` always re-downloaded** — the embedded version previously
  included the `cli-` tag prefix (`cli-v0.1.4`), which broke version
  comparison (`NaN`); the released CLI never reported "up to date".

## [0.1.4] - 2026-08-10

### Added

- **`lexa-cli deploy --clean` undeploy** — full teardown per flavor
- **Deploy derives `LXK_ACCESS_TEAM` from `--team-domain`** — no separate flag
  needed when the Access Google IdP is per-team

## [0.1.3] - 2026-08-10

### Fixed

- **Prod state root is `~/.lexa`** — materialize only the selected flavor's
  compose files instead of all of them

## [0.1.2] - 2026-08-10

### Added

- **Per-flavor state roots** — staging and prod keep separate deploy state
- **Separate Access Google IdP per flavor** — Access policies are scoped to
  the right IdP on deploy
- **Docs: Google OAuth + Cloudflare Access setup guide** — `docs/DEPLOYMENT.md`

### Fixed

- **Deploy forwards `LXK_ACCESS_TEAM` to the container** — previously the
  env var was set on the host but not passed through compose

## [0.1.1] - 2026-08-10

### Fixed

- **Reusable Access policies updated via the account-level endpoint** — the
  previous per-application endpoint could not modify reusable policies

## [0.1.0] - 2026-08-10

Initial release. Operator CLI wrapping the Lexa REST API with `lxk_` Bearer
keys: `machine install|listen|start|stop|restart|status|logs|list|uninstall`,
`task|wiki|project` CRUD, `deploy`, `upgrade`, `github status|setup|check`.
