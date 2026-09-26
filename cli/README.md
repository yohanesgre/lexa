# lx

Operator CLI for a self-hosted Lexa server — tasks, wiki, projects, and GitHub
sync. Wraps the Lexa REST API with `lxk_` Bearer keys. The CLI is versioned and
released INDEPENDENTLY of the web app: `cli-vX.Y.Z` tags publish the binary;
`vX.Y.Z` tags publish the app image.

Lexa is self-hosted project management, not a software factory. The CLI is an
**operator + external-harness client** — it reads and writes work items, and
nothing else is API-stable.

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
lx login --url https://lexa.example.com --key lxk_...   # stores creds in ~/.lexa/<host>/config.json
lx status                                               # server + auth + project count

# Work items
lx project list             # list projects
lx task list --project <slug>
lx wiki list --project <slug>
```

Environment fallbacks when not logged in: `LEXA_URL` and `LEXA_API_KEY`.

## Commands

| Command | Notes |
|---|---|
| `login [<url>] [--url <base>] [--key <lxk_...>]` | Saves credentials (chmod 600). Without `--key`: browser-approval device login. |
| `logout` | Removes saved credentials. |
| `status` | Server reachability + auth + project count. |
| `upgrade` | Self-updates the CLI binary (GitHub release). |
| `project list [--json]` | |
| `task list --project <slug> [--limit N] [--json]` | |
| `task get <id> --project <slug> [--json]` | |
| `task create --project <slug> --column <name> --swimlane <name> --title <t> [--description <md>]` | Description is Markdown, converted to TipTap. |
| `task move <id> --project <slug> --column <name> [--swimlane <name>]` | |
| `task update <id> --project <slug> [--title <t>] [--priority <p>] [--type <t>]` | |
| `wiki list --project <slug> [--json]` | |
| `wiki get <pageSlug> --project <slug> [--json]` | |
| `github status/setup/check` | GitHub App sync configuration + acceptance round-trip. |

Columns and swimlanes are resolved by NAME (case-insensitive). `lx --help`
prints the full reference; `lx <group>` prints group help.

## For external agent harnesses

The stable integration surface is exactly:

- **Read/write work items** through `lx task list|get|create|move|update` and
  `lx wiki list|get`.
- `--json` on list/get commands for machine-readable output.
- Task and wiki documents are TipTap JSON; the CLI renders them to Markdown
  (`task get`, `wiki get`) and accepts Markdown on `task create`.
- Task ids accept the full UUID **or** the ticket key (`PREFIX-N`, e.g.
  `NIM-12`) anywhere an id is taken — the server resolves both.

No other command is API-stable. Document sources
(`/api/projects/:slug/documents/:type/:id/sources`) have no CLI command; use
the web app for those.

## Development

```bash
bun run compile:cli        # prod binary → bin/lx (bun build --compile)
bun run install:cli-dev    # dev shim → ~/.local/bin/lx-dev (runs live source, never overwrites prod)
bun run uninstall:cli-dev  # removes the dev shim
```

- The CLI version lives in `cli/package.json` (read by `cli/src/version.ts` —
  never regenerated). `publish-cli.yml` verifies the `cli-v*` tag matches it.
- `--version` prints the embedded version; releases also write
  `cli/CHANGELOG.md`.

Agent skill: `~/.agents/skills/lexa-cli/SKILL.md`.
