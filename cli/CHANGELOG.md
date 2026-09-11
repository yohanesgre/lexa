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

### Changed

- CLI binary renamed `lexa-cli` → `lx`.
- Releases publish the legacy `lexa-cli` asset for one transition cycle.
- Dev shim renamed `lx-dev`.

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
