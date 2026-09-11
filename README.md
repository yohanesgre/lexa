# Lexa

Self-hosted project management for small teams. Kanban with swimlanes and WIP limits, rich task descriptions, a nested wiki, milestones, the Hearth AI writing assistant and Herald chat, team auth, and two-way GitHub issue sync.

Stack: **Bun + SQLite + TanStack Start (React) + Effect-TS + Tailwind** — self-hosted via `scripts/install.sh` (docker, bare metal, Cloudflare Workers, or dev).

## Features

- **Kanban board** — swimlanes (Backlog + sprints), WIP limits enforced atomically, drag-and-drop reorder, archive/restore, per-project priority/type field config, required-field gates, stable ticket keys
- **Tasks** — rich TipTap descriptions, assignees, activity timeline + comments, attachments, subtasks / blocked-by / related links, GitHub issue links with sync status
- **Nested wiki** — hierarchical pages, FTS5 full-text search, revisions with restore, public share links
- **Milestones** — goals above sprints with target dates, progress tracking, timeline gantt
- **Hearth** — AI writing assistant with builtin agents + skills rule bundles, per-project engines, pluggable runtimes (OpenCode / Hermes / Command Code), machine listener with persistent daemon
- **Herald chat** — streaming AI chat with threads, multi-provider gateway, and a proposed-actions approval flow for task/wiki writes
- **Auth & teams** — email/password login with cookie sessions, teams and roles, workspace invites, `lxk_` API keys for machines
- **Two-way GitHub sync** — link tasks to issues, echo-suppressed webhooks, column ↔ issue-state mapping, out-of-sync surfacing
- **`lx`** — headless operator CLI for tasks, wiki, machines, keys, and upgrades

## Quickstart (local dev)

Requires [Bun](https://bun.sh).

```bash
bun install
bun run setup          # first-time: admin email, API key, migrations, sample data
bun run dev:full       # API (:3000) + vite frontend (:5173)
# open http://localhost:5173
```

- DB lives at `data/lexa.db` (SQLite WAL) — delete it to start fresh.
- Health check: `curl http://localhost:3000/api/health`
- First-run web wizard at `/setup` (fresh installs only).

### Verification

```bash
tsc --noEmit
vitest run
```

## Deploying (self-host)

One install script — no clone, no repo checkout:

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install.sh | bash -s -- docker
```

The installer hub serves the newest release (pin with `?ref=vYYYY.MINOR.MICRO`,
or use a raw `.../lexa/<tag>/scripts/install.sh` URL for a tag, `main` for
bleeding edge). Targets:

| Target | What it does |
|---|---|
| `docker` | prebuilt image from `ghcr.io/yohanesgre/lexa`, compose up, health check (default 127.0.0.1:8080) |
| `bare` | release tarball + env file + `lexa-start.sh` (systemd opt-in via `--systemd`) |
| `workers` | Cloudflare Workers + D1 + R2 + KV via `bunx wrangler` — or zero-file: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yohanesgre/lexa) (DRAFT-UNVERIFIED, see `docs/DEPLOYMENT.md`; disable Builds auto-deploy after) |
| `dev` | clone the repo, `bun install`, `bun run dev:full` |

Flags: `--ref <tag|branch>`, `--name <name>` (workers), `--port`, `--bind`, `--domain` (workers custom domain), `--systemd`
(bare), `--image <tag>` (docker version pin).

**First run:** open `http://<host>:<port>/setup` — create the first admin
(email + password, min 8 chars). The wizard is the **only** provisioning path;
passwords never pass through the shell.

**lx** is the headless operator frontend for the running server (tasks,
wiki, machines, keys, upgrades) — it installs separately and has **no deploy
commands** (removed in cli-v2026.2.0):

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install-cli.sh | bash
```

**Uninstall** (data kept unless `--purge`):

```bash
curl -fsSL https://install.yohanesgre.com/lexa/uninstall.sh | bash -s -- docker
```

- **Upgrade = re-run `install.sh`** from the new tag (idempotent; data survives)
- Full contract (per-target details, env reference, security notes):
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- GitHub App setup: [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)

## CLI

`lx` wraps the REST API with the same `lxk_` Bearer auth as the web app:

```bash
lx login --url https://lexa.example.com   # browser-approval device flow
lx task list --project my-project
lx task create --project my-project --column "In Progress" --swimlane Backlog --title "Ship it"
lx wiki get --project my-project getting-started
lx upgrade                          # self-update the CLI binary
```

Columns and swimlanes are referenced by name, projects by slug. Every `list`/`get` accepts `--json`. `LEXA_URL` + `LEXA_API_KEY` env vars replace the saved login.

## For agents

Lexa is scriptable end to end — agents drive it without touching a browser:

```bash
export LEXA_URL=https://lexa.example.com LEXA_API_KEY=lxk_...
lx status                                   # connectivity + auth check
lx task list --project my-project --json    # machine-readable
lx task get NIM-12 --project my-project     # description as Markdown
lx task move <id> --project my-project --column Done
lx wiki get getting-started --project my-project
```

- One `lxk_` key (Settings → API Keys) is the only credential. Commands
  never prompt when piped and exit non-zero with errors on stderr.
- Columns/swimlanes by name, projects by slug, tasks by UUID or PREFIX-N
  ticket key; every `list`/`get` takes `--json`.
- For anything the CLI doesn't cover, speak the REST contract directly:
  [`docs/API.md`](docs/API.md).
- To run Lexa tasks *as* an agent runtime (persistent workspace, repo
  context, heartbeat), install the machine listener:
  `lx machine install`.

## Environment variables

`.env.example` is the tracked dev template (copy to `.env`). The
self-hosting contract — per-target layout, env reference, security notes —
lives in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Values are generated on
the machine and never committed (`.env*` is gitignored):

| Situation | What's needed |
|---|---|
| Local dev (`.env`) | `bun run setup` records `LXK_ADMIN_EMAILS`; machine keys minted post-setup; `GITHUB_*` only if you want two-way GitHub sync |
| Self-hosted (install script) | the script writes the env file (`LXK_ENV`, `LXK_PUBLIC_URL`); machine keys minted post-setup (login → Settings → API Keys); `GITHUB_*` preserved across re-runs |
| Optional | `LXK_HEARTH_DAEMON_TOKEN`, `LXK_MAX_BODY_MB` (body cap, default 16), `LOG_LEVEL` |

## Documentation

Design and API docs live in [`docs/`](docs/):

| Doc | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Big picture: stack, auth, sync, request pipeline |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | SQL schema and data invariants |
| [`docs/API.md`](docs/API.md) | REST contract |
| [`docs/LAYERS.md`](docs/LAYERS.md) | Effect service patterns, error catalog, webhook/auth flows |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Self-hosting via install.sh: targets, env reference, bootstrap |
| [`docs/CLOUDFLARE_WORKERS.md`](docs/CLOUDFLARE_WORKERS.md) | Workers runtime: D1/R2/KV bindings, quirks, cron |
| [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md) | GitHub App setup: webhook URL/secret, private key |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, workflow, PR guidelines. Note: frontend work requires access to the private wireframes repo; backend/API/docs/CLI contributions are fully open.

## License

MIT — see [LICENSE](LICENSE).
