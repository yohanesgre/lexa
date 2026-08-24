# lexa-cli

Operator CLI for a Lexa server — tasks, wiki, projects, Hearth machine/daemon
management, deploy, and upgrade. Wraps the Lexa REST API with `lxk_` Bearer
keys. The CLI is versioned and released INDEPENDENTLY of the web app:
`cli-vX.Y.Z` tags publish the binary; `vX.Y.Z` tags publish the app image.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
```

This downloads the prebuilt binary from the newest `cli-v*` GitHub release to
`~/.local/bin/lexa-cli`. Self-update with:

```bash
lexa-cli upgrade
```

## Quick start

```bash
lexa-cli login --url https://lexa.example.com --key lxk_...   # stores creds in ~/.lexa/config.json
lexa-cli status                                               # server + machine health

# Hearth machine management (the listener supervises per-runtime daemons)
lexa-cli machine install          # install the listener (systemd unit)
lexa-cli machine listen           # run the listener under your own supervisor
lexa-cli machine list             # list machines + runtimes

# Work items
lexa-cli task list                # list tasks
lexa-cli project list             # list projects
lexa-cli wiki list                # list wiki pages
```

Environment fallbacks when not logged in: `LEXA_URL` and `LEXA_API_KEY`.

## Deploy

```bash
lexa-cli deploy lexa.example.com [staging|prod]
```

Pulls the prebuilt image from ghcr.io and wires up Docker + cloudflared
tunnel + Cloudflare Access. See `docs/DEPLOYMENT.md` for the full setup
guide (GitHub App, Google OAuth, Access policies).

## Development

```bash
bun run compile:cli        # prod binary → bin/lexa-cli (bundles the Hearth daemon)
bun run install:cli-dev    # dev shim → ~/.local/bin/lexa-cli-dev (runs live source, never overwrites prod)
bun run uninstall:cli-dev  # removes the dev shim
```

- `bun run compile:cli` regenerates `cli/src/packed.ts` (daemon embed) and
  `cli/src/packed-compose.ts` (deploy compose files) with real content. The
  committed state is a stub for both — restore before committing:
  `git checkout cli/src/packed.ts cli/src/packed-compose.ts`.
- The CLI version lives in `cli/package.json` (read by `cli/src/version.ts` —
  never regenerated). `publish-cli.yml` verifies the `cli-v*` tag matches it.
- `--version` prints the embedded version; releases also write
  `cli/CHANGELOG.md`.

Agent skill: `~/.agents/skills/lexa-cli/SKILL.md`.
