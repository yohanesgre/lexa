---
name: lexa-cli
description: Operate the Lexa CLI (`lx`) against a self-hosted Lexa server — authenticate with `lx login`, then read and write tasks, columns, swimlanes, milestones, wiki pages, and project settings, and upgrade the CLI or a self-hosted Cloudflare Workers deploy. Use when the user asks to run `lx` commands or perform Lexa operations from a terminal or an agent harness.
---

# lexa-cli

`lx` is the operator CLI for a self-hosted Lexa server. It wraps the Lexa REST
API with the same `lxk_` Bearer auth as the web app, and gives humans and
external agent harnesses a non-browser way to drive Lexa.

Lexa is self-hosted project management, not a software factory. The CLI is an
**operator + external-harness client** — it reads and writes work items, and
nothing else is API-stable.

## Auth

```bash
lx login [<url>]                        # browser-approval device flow (prints a link to approve)
lx login --url <base> --key lxk_...     # legacy key login
lx login <url>                          # bare host OK (e.g. lexa.example.com)
```

- A bare host (`--url`/`<url>`) resolves to a full base URL: loopback uses
  `http`, everything else `https`.
- Without `--key`, `lx login` starts the device flow and polls until a
  logged-in user approves; the minted key is `lxk_` + 43 chars.
- Saved credentials live per host under `~/.lexa/<host>/config.json` (chmod
  600); the active host is remembered.
- `lx status` prints host + server reachability + auth + project count.
- `lx logout [--url <base>] [--all]` removes the active host's login, or all.
- Environment fallbacks when not logged in: `LEXA_URL`, `LEXA_API_KEY`. Flags
  override the saved login; `--url X` never ships another host's ambient key.
- Several saved logins and no hint is an error — pass `--url <base>`; the CLI
  never guesses alphabetically.
- Admin writes (project/column/swimlane/milestone, `field-config put`,
  `lx settings *`) need a superadmin identity (session or key) or a server/bare
  key. `settings api-keys create` additionally needs a user-bound admin — a
  bare key gets `403 NO_USER_CONTEXT`.

## Command surface

Common flags: `--project <slug>` selects the project; `--json` is a read-side
flag (reads only). Task ids accept the full UUID or the ticket key (`PREFIX-N`,
e.g. `NIM-12`) anywhere an id is taken.

### Tasks

```bash
lx task list   --project <slug> [--limit N] [--json]
lx task get    <id> --project <slug> [--json]
lx task create --project <slug> --column <name> --swimlane <name> --title <t> [--description <md>]
lx task move   <id> --project <slug> --column <name|id> [--swimlane <name|id>] \
               [--before <id|PREFIX-N>] [--after <id|PREFIX-N>] [--clear-due]
lx task update <id> --project <slug> [--title <t>] [--description <md>] \
               [--priority <id>] [--type <id>] [--assignees <a,b> | --assignees=] \
               [--due <YYYY-MM-DD>] [--clear-due]
lx task delete <id> --project <slug>
```

- Descriptions are Markdown, converted to TipTap JSON; `task get` renders TipTap
  back to Markdown.
- `--assignees=` (empty) clears assignees; `--clear-due` clears the due date.
- `--before`/`--after` place the card at a position in the target column.

### Columns, swimlanes, milestones

```bash
lx column list    --project <slug> [--json]      # WIP limit, done, GitHub state
lx column create  --project <slug> --name <n> [--color <hex>] [--wip-limit <n>] \
                  [--required-fields <a,b,c>] [--github-state open|closed] [--position <n>]
lx column update  <ref> --project <slug> [--name <n>] [--color <hex>] \
                  [--wip-limit <n|none>] [--required-fields <a,b,c>|--required-fields=] \
                  [--github-state open|closed|none] [--done true|false] [--position <n>]
lx column delete  <ref> --project <slug>

lx swimlane list   --project <slug> [--json]
lx swimlane create --project <slug> --name <n> [--description <s>] [--due <date>] \
                   [--start <date>] [--milestone <id|name>] [--position <n>]
lx swimlane update <ref> --project <slug> [--name <n>] [--description <s>] \
                   [--due <date|none>] [--start <date|none>] \
                   [--milestone <id|name|none>] [--position <n>]
lx swimlane delete <ref> --project <slug>

lx milestone list   --project <slug> [--json]
lx milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]
lx milestone update <ref> --project <slug> [--name <n>] [--description <s>] \
                    [--due <YYYY-MM-DD>|--clear-due] [--position <n>]
```

Admin-only. Columns, swimlanes, and milestones resolve by name
(case-insensitive) or id; `none` clears a WIP limit / date / milestone.

### Wiki

```bash
lx wiki list   --project <slug> [--json]
lx wiki get    <pageSlug> --project <slug> [--json]
lx wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]
lx wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>] \
               [--parent <pageSlug> | --parent-root] [--position <n>]
lx wiki delete <pageSlug> --project <slug>
```

Pages are addressed by slug. A `--slug` rename prints `old → new` — capture the
new slug for follow-up calls.

### Projects, field config, settings

```bash
lx project list [--json]
lx project create --name <n> [--slug <s>] [--description <s>] [--team <teamId>]
lx project update <slug> [--name <n>] [--description <s>]
lx project delete <slug> --yes

lx field-config get --project <slug> [--json]
lx field-config put --project <slug> --file <path|->    # `-` reads stdin

lx settings rate-limit get
lx settings rate-limit set --max <n> --window-min <m>
lx settings api-keys list
lx settings api-keys create --name <n>
lx settings api-keys revoke <id>
```

Admin-only except `project list` and `field-config get`.

### GitHub sync (optional)

```bash
lx github status
lx github setup                                   # --app-id, --pem-file, --webhook-secret
lx github check <slug> <owner/repo>
lx github link <id> --project <slug> --repo <owner/name>
lx github link-existing <id> --project <slug> --repo <owner/name> --issue <n>
lx github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )
```

GitHub sync is configured in the web app: Settings → Workspace → Integrations
→ GitHub Sync.

## Upgrades

```bash
lx upgrade          # self-update the CLI binary from the newest cli-v* release
```

```bash
lx worker upgrade [--dir <cf-workers>] [--worker <name>] [--cf-token <tok>] \
                  [--version <tag>] [--dry-run] [--yes] [--force]
```

`lx worker upgrade` updates a self-hosted Lexa web app on Cloudflare Workers.
Run it from your `cf-workers/` custody dir (or pass `--dir`). It fetches and
verifies the release, preserves custody/bindings, backs up the deploy dir,
applies pending D1 migrations, deploys, and rolls back on failure. `--dry-run`
reports the target version, checksum, and pending migrations without changes.

## Install this skill

```bash
lx skill install [--global | --local] [--force]
```

Writes this skill to `~/.agents/skills/lexa-cli/SKILL.md` (`--global`) or
`./.agents/skills/lexa-cli/SKILL.md` (`--local`). With no target flag the CLI
prompts (TTY only). An existing file is refused unless `--force` is given.
Harnesses auto-discover `~/.agents/skills` and a project's `.agents/skills`.

## Exit codes and stability

- `0` — success.
- `1` — failure: usage error, not logged in, or API error (printed to stderr
  with the command's prefix and any error code, e.g. ` [FORBIDDEN]`).
- `130` — an interactive prompt was cancelled (Ctrl-C).

The stable integration surface is exactly the read/write work-item commands:
`lx task list|get|create|move|update|delete`,
`lx wiki list|get|create|update|delete`, and
`lx github link|link-existing|unlink`. `--json` is available on read commands
only. **No other command is API-stable.** Document sources
(`/api/projects/:slug/documents/:type/:id/sources`) have no CLI command; use
the web app for those.
