# Lexa

Self-hosted project management for a small game dev team (2–5 people). Kanban with swimlanes and WIP limits, tasks with rich descriptions, a nested wiki, an MCP server so AI agents (Hermes/OpenCode) can manage tasks, a Forge AI writing assistant, and two-way GitHub issue sync.

Stack: **Bun + SQLite + TanStack Start (React) + Effect-TS + Tailwind**. Served behind a cloudflared tunnel.

## Features

- **Kanban board** — swimlanes, WIP limits (enforced atomically), drag-and-drop reorder, archive/restore, per-project priority/type field config
- **Tasks** — rich TipTap descriptions, assignees, required-field gates per column, subtasks / blocked-by / related links
- **Nested wiki** — hierarchical pages, FTS5 search
- **MCP server** — agents manage tasks by name (not UUID), Markdown at the boundary
- **Two-way GitHub sync** — one task ↔ one issue, echo-suppressed webhooks, column→state mapping
- **Forge** — AI writing assistant: agents + skills rule bundles (AGENTS.md/SKILL.md delivered into the run dir), daemon runtimes managed via `lexa-cli machine`
- **Auth** — API keys for machines, Cloudflare Access (Google OAuth) for humans

## Quickstart (local dev)

```bash
bun install
bun run setup          # first-time: admin email, API key, migrations, sample data
bun run dev:full       # API (:3000) + vite frontend (:5173)
# open http://localhost:5173
```

- DB lives at `data/lexa.db` (SQLite WAL). Delete it to start fresh.
- Health check: `curl http://localhost:3000/api/health`
- First-run web wizard at `/setup` (fresh installs only).

### Verification

```bash
tsc --noEmit
vitest run
```

## Environment variables

`.env.example` lists every key the app reads, but you rarely edit it by hand — most values are generated or prompted:

| Situation | Fill by hand | Generated / prompted |
|---|---|---|
| Local dev (`.env`) | `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`/`_FILE`, `GITHUB_WEBHOOK_SECRET` — only if you want two-way GitHub sync ([`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)) | `LXK_API_KEY` + `VITE_LXK_API_KEY` and `LXK_ADMIN_EMAILS` via `bun run setup`; the rest have defaults |
| Staging/prod (`.env.staging` / `.env.prod`) | `GITHUB_*` on first deploy if you want issue sync; `LXK_ACCESS_AUD` after deploy — grab the Access audience tag from the Cloudflare dashboard (`https://<team>.cloudflareaccess.com/cdn-cgi/access/get-ksi`) to enable Access JWT verification | `lexa-cli deploy` prompts for admin email, API key and tunnel token, and writes the file (preserving `GITHUB_*` across re-runs) |
| Optional anywhere | `LXK_FORGE_DAEMON_TOKEN` (daemon shared secret instead of a Settings API key), `LXK_MAX_BODY_MB` (body cap, default 16), `LOG_LEVEL` | — |

`LXK_SEED_DEV` is dev-only and set by `scripts/dev.sh`; `COMPOSE_PROJECT_NAME` is read by docker compose, not the app. The server never needs the GitHub private key inline when `GITHUB_PRIVATE_KEY_FILE` is set (read at boot, no escaping).

## CLI

`lexa-cli` wraps the REST API with the same `lxk_` Bearer auth as the web app. Log in once, then drive Lexa from a terminal or scripts:

```bash
lexa-cli login --url http://localhost:3000 --key lxk_...   # prompts interactively when flags are omitted
lexa-cli status                                            # server health, auth, project count
```

| Command | What it does |
|---|---|
| `login [--url <base> --key <lxk_...>]` | Save credentials (`~/.lexa/config.json`, chmod 600) and register this machine |
| `logout` | Remove saved credentials |
| `status` | Server health + auth + project count |
| `task list [--limit N] [--json]` | List tasks (`--project <slug>` required on all task commands) |
| `task create --column <name> --swimlane <name> --title <t>` | New task — columns/swimlanes by name, not id |
| `task get <id> [--json]` | Inspect a task |
| `task move <id> --column <name> [--swimlane <name>]` | Move a task between columns/swimlanes |
| `task update <id> [--title] [--priority] [--type]` | Edit a task |
| `wiki list [--json]` | List wiki pages (`--project <slug>`) |
| `wiki get <pageSlug> [--json]` | Read a page — TipTap content rendered as Markdown |
| `project list [--json]` | Projects |
| `runtime list` / `runtime delete <id>` | Forge daemon view, server-side |
| `machine list` | Registered machines |
| `machine install [--no-systemd]` / `machine listen` | Install + run the Forge listener (no-systemd: run it under your own supervisor) |
| `machine start \| stop \| restart \| status \| logs` | Manage the `lexa-forge-listen` systemd user unit |
| `machine delete <id>` | Remove a machine and its runtimes |
| `machine workspace list \| sync` | Per-project Forge workspaces under `~/.lexa/projects/` |
| `deploy <domain> [dev\|staging\|prod] [--bare]` | Docker + cloudflared tunnel + Access (see Deploying) |

Every `list`/`get` accepts `--json` for script-friendly output. `LEXA_URL` + `LEXA_API_KEY` env vars replace the saved login; explicit flags win.

Two builds, one interface:

- **Dev** — `bun run lexa-cli-dev`, or `bun run install:cli-dev` (→ `~/.local/bin/lexa-cli-dev`): a shim that runs the live repo source via bun. Picks up code changes without compiling; needs the repo at the installed path; never touches the prod name.
- **Prod** — `bun run compile:cli` + `bun run install:cli` (→ `~/.local/bin/lexa-cli`): a standalone compiled binary, self-contained for machines without the repo. The Forge daemon source is bundled and embedded (the listener writes it to `~/.local/share/lexa-forge/daemon.js`); the systemd listener unit runs this binary. `compile:cli` regenerates `scripts/cli/packed.ts` — restore the committed stub with `git checkout scripts/cli/packed.ts` after compiling.

## Deploying

`lexa-cli deploy <domain> [dev|staging|prod]` — Docker + cloudflared tunnel + Cloudflare Access. Dev delegates to the `bun run setup` wizard; staging/prod provision the tunnel, DNS, ingress and Access IdP/app/policy (prompting for a Cloudflare API token and Google OAuth client, cached in `~/.lexa/config.json`), write the env file, and bring up compose. `--bare` provisions and writes files but skips docker (for CI/manual bring-up). GitHub App creds are preserved across re-runs.

## Documentation

All design and spec docs live in [`docs/`](docs/):

| Doc | Contents |
|---|---|
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | SQL schema and data invariants |
| [`docs/LAYERS.md`](docs/LAYERS.md) | Effect service patterns, error catalog, webhook/auth flows |
| [`docs/API.md`](docs/API.md) | REST contract |
| [`docs/MCP.md`](docs/MCP.md) | Agent-facing MCP tool contract |
| [`docs/RATE_LIMITING.md`](docs/RATE_LIMITING.md) | App-level rate limiting for `/api` and `/mcp` (webhook-exempt) |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | PHOSPHOR design tokens and component specs |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Big picture and decisions log |
| [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md) | GitHub App setup: webhook URL/secret, private key, Access bypass policies |
| [`docs/REVIEW.md`](docs/REVIEW.md) | Historical design-review record |
| [`docs/RELEASE.md`](docs/RELEASE.md) | v0.1.0 release plan and verification gates |
| [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) | Changelog |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Security model |

`wireframes/` holds the static UI/UX source of truth (HTML previews — `bash wireframes/build.sh` rebuilds them). `AGENTS.md` is the agent rules file used by AI coding agents working on this repo.
