# lx

Operator CLI for a Lexa server — tasks, wiki, projects, Hearth machine/daemon
management, deploy, and upgrade. Wraps the Lexa REST API with `lxk_` Bearer
keys. The CLI is versioned and released INDEPENDENTLY of the web app:
`cli-vX.Y.Z` tags publish the binary; `vX.Y.Z` tags publish the app image.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
```

This downloads the prebuilt binary from the newest `cli-v*` GitHub release to
`~/.local/bin/lx`. Self-update with:

```bash
lx upgrade
```

## Quick start

```bash
lx login --url https://lexa.example.com --key lxk_...   # stores creds in ~/.lexa/config.json
lx status                                               # server + machine health

# Hearth machine management (the listener supervises per-runtime daemons)
lx machine install          # install the listener (systemd unit)
lx machine listen           # run the listener under your own supervisor
lx machine list             # list machines + runtimes

# Work items
lx task list                # list tasks
lx project list             # list projects
lx wiki list                # list wiki pages
```

Environment fallbacks when not logged in: `LEXA_URL` and `LEXA_API_KEY`.

## Deploy

```bash
lx deploy lexa.example.com [staging|prod] [--direct]
```

Pulls the prebuilt image from ghcr.io and wires up Docker + an
outbound-only cloudflared tunnel — no public IP, no open ports (works
behind NAT/CGNAT). `--direct` skips Cloudflare entirely for machines with
a public IP + own reverse proxy. See `docs/DEPLOYMENT.md` for the full
setup guide (GitHub App).

## Development

```bash
bun run compile:cli        # prod binary → bin/lx (bundles the Hearth daemon)
bun run install:cli-dev    # dev shim → ~/.local/bin/lx-dev (runs live source, never overwrites prod)
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
