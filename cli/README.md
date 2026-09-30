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
lx column list --project <slug>        # columns + WIP limits
```

Environment fallbacks when not logged in: `LEXA_URL` and `LEXA_API_KEY`.

**Admin operations need an admin identity.** Project/column/swimlane/milestone
writes, `field-config put`, and `lx settings *` need a superadmin identity
(session or key) or a server/bare key; `settings api-keys create` additionally
needs a user-bound admin — a bare key gets `403 NO_USER_CONTEXT`. A member-bound
key is rejected with `403 FORBIDDEN "Admin role required"`.

## Commands

| Command | Notes |
|---|---|
| `login [<url>] [--url <base>] [--key <lxk_...>]` | Saves credentials (chmod 600). Without `--key`: browser-approval device login. |
| `logout` | Removes saved credentials. |
| `status` | Server reachability + auth + project count. |
| `upgrade` | Self-updates the CLI binary (GitHub release). |
| `project list [--json]` | |
| `project create --name <n> [--slug <s>] [--description <s>] [--team <teamId>]` | Admin. |
| `project update <slug> [--name <n>] [--description <s>]` | Admin. |
| `project delete <slug> --yes` | Admin. `--yes` is required — no interactive confirm. |
| `task list --project <slug> [--limit N] [--json]` | |
| `task get <id> --project <slug> [--json]` | |
| `task create --project <slug> --column <name> --swimlane <name> --title <t> [--description <md>]` | Description is Markdown, converted to TipTap. |
| `task move <id> --project <slug> --column <name\|id> [--swimlane <name\|id>] [--before <id\|PREFIX-N>] [--after <id\|PREFIX-N>] [--clear-due]` | `--before`/`--after` place the card at a position; `--clear-due` drops an existing due date. |
| `task update <id> --project <slug> [--title <t>] [--description <md>] [--priority <id>] [--type <id>] [--assignees <a,b> \| --assignees=] [--due <YYYY-MM-DD>] [--clear-due]` | `--assignees=` (empty) clears assignees; `--clear-due` clears the due date. |
| `task delete <id> --project <slug>` | Deletes the task and its activity history. |
| `column list --project <slug> [--json]` | Table shows `WIP` (limit or `—`), `DONE`, `GITHUB` state. |
| `column create --project <slug> --name <n> [--color <hex>] [--wip-limit <n>] [--required-fields <a,b,c>] [--github-state open\|closed] [--position <n>]` | Admin. |
| `column update <ref> --project <slug> [--name <n>] [--color <hex>] [--wip-limit <n\|none>] [--required-fields <a,b,c>\|--required-fields=] [--github-state open\|closed\|none] [--done true\|false] [--position <n>]` | Admin. `none` clears WIP limit / GitHub state; empty `--required-fields=` clears them. |
| `column delete <ref> --project <slug>` | Admin. |
| `swimlane list --project <slug> [--json]` | |
| `swimlane create --project <slug> --name <n> [--description <s>] [--due <date>] [--start <date>] [--milestone <id\|name>] [--position <n>]` | Admin. |
| `swimlane update <ref> --project <slug> [--name <n>] [--description <s>] [--due <date\|none>] [--start <date\|none>] [--milestone <id\|name\|none>] [--position <n>]` | Admin. `none` clears the date / milestone. |
| `swimlane delete <ref> --project <slug>` | Admin. |
| `milestone list --project <slug> [--json]` | |
| `milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]` | Admin. |
| `milestone update <ref> --project <slug> [--name <n>] [--description <s>] [--due <YYYY-MM-DD>\|--clear-due] [--position <n>]` | Admin. |
| `field-config get --project <slug> [--json]` | |
| `field-config put --project <slug> --file <path\|->` | Admin. `-` reads the config from stdin. |
| `settings rate-limit get` / `set --max <n> --window-min <m>` | Admin. |
| `settings api-keys list` / `create --name <n>` / `revoke <id>` | Admin. The raw key is printed once at create. |
| `wiki list --project <slug> [--json]` | |
| `wiki get <pageSlug> --project <slug> [--json]` | Pages are addressed by slug. |
| `wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]` | Prints the created page slug. |
| `wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>] [--parent <pageSlug> \| --parent-root] [--position <n>]` | Reparent with `--parent` / `--parent-root`. A `--slug` rename prints `old → new`. |
| `wiki delete <pageSlug> --project <slug>` | |
| `github status/setup/check` | GitHub App sync configuration + acceptance round-trip. |
| `github link <id> --project <slug> --repo <owner/name>` | Creates a GitHub issue from the task and links it. |
| `github link-existing <id> --project <slug> --repo <owner/name> --issue <n>` | Links an existing issue to the task. |
| `github unlink <id> --project <slug> (--issue-id <nodeId> \| --repo <owner/name> --issue <n>)` | Dual addressing: node id, or repo + issue number. |

Columns, swimlanes, and milestones are resolved by NAME (case-insensitive) or
ID, and WIP limits are visible in `lx column list`. `lx --help` prints the full
reference; `lx <group>` prints group help.

## For external agent harnesses

The stable integration surface is exactly:

- **Read/write work items** through `lx task list|get|create|move|update|delete`
  and `lx wiki list|get|create|update|delete`, plus `lx github
  link|link-existing|unlink`.
- `--json` on read commands only (work-item `list`/`get` and `field-config
  get`) for machine-readable output; `lx settings *` takes no `--json`. Writes
  print human-readable confirmations.
- Task and wiki documents are TipTap JSON; the CLI renders them to Markdown
  (`task get`, `wiki get`) and accepts Markdown on writes.
- Task ids accept the full UUID **or** the ticket key (`PREFIX-N`, e.g.
  `NIM-12`) anywhere an id is taken — the server resolves both.
- Wiki pages are addressed by **slug**, including on `wiki create`; a
  `wiki update --slug` rename prints `old → new`, so capture the new slug for
  follow-up calls.
- Column WIP limits are readable from `lx column list` (table `WIP` column or
  `--json`).
- Project/column/swimlane/milestone writes, `field-config put`, and
  `lx settings *` are **admin-only**: they need a superadmin identity (session or
  key) or a server/bare key; `settings api-keys create` additionally needs a
  user-bound admin — a bare key gets `403 NO_USER_CONTEXT`. A member-bound key
  gets `403 FORBIDDEN "Admin role required"`.

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
