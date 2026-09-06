# Lexa

Self-hosted project management for small teams. Kanban with swimlanes and WIP limits, rich task descriptions, a nested wiki, milestones, the Hearth AI writing assistant and Herald chat, team auth, and two-way GitHub issue sync.

Stack: **Bun + SQLite + TanStack Start (React) + Effect-TS + Tailwind**, served behind a cloudflared tunnel.

## Features

- **Kanban board** — swimlanes (Backlog + sprints), WIP limits enforced atomically, drag-and-drop reorder, archive/restore, per-project priority/type field config, required-field gates, stable ticket keys
- **Tasks** — rich TipTap descriptions, assignees, activity timeline + comments, attachments, subtasks / blocked-by / related links, GitHub issue links with sync status
- **Nested wiki** — hierarchical pages, FTS5 full-text search, revisions with restore, public share links
- **Milestones** — goals above sprints with target dates, progress tracking, timeline gantt
- **Hearth** — AI writing assistant with builtin agents + skills rule bundles, per-project engines, pluggable runtimes (OpenCode / Hermes / Command Code), machine listener with persistent daemon
- **Herald chat** — streaming AI chat with threads, multi-provider gateway, and a proposed-actions approval flow for task/wiki writes
- **Auth & teams** — email/password login with cookie sessions, teams and roles, workspace invites, `lxk_` API keys for machines
- **Two-way GitHub sync** — link tasks to issues, echo-suppressed webhooks, column ↔ issue-state mapping, out-of-sync surfacing
- **`lexa-cli`** — operator CLI for tasks, wiki, machines, deploy, and upgrades

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

`lexa-cli deploy <domain> [staging|prod]` provisions everything: Docker + cloudflared tunnel, DNS, env file, then pulls the prebuilt image and brings up compose (`staging` → `lexa-preview.<domain>`, `prod` → `lexa.<domain>`). The image is built and pushed by CI (`ghcr.io/yohanesgre/lexa`). `--direct` skips Cloudflare for your own reverse proxy; a Workers + D1 flavor is also available.

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
lexa-cli deploy lexa.example.com prod
```

- **Redeploy = upgrade** — deploy always pulls the latest image
- `--image <tag>` pins a specific version
- `--clean` recreates from scratch (removes the `lexa-data` volume — DB wiped)
- Full contract (flavors, env reference, GitHub App setup, secrets hygiene): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) + [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md)

## CLI

`lexa-cli` wraps the REST API with the same `lxk_` Bearer auth as the web app:

```bash
lexa-cli login --url https://lexa.example.com --key lxk_...
lexa-cli task list --project my-project
lexa-cli task create --project my-project --column "In Progress" --swimlane Backlog --title "Ship it"
lexa-cli wiki get --project my-project getting-started
lexa-cli deploy lexa.example.com prod     # deploy / upgrade the server
lexa-cli upgrade                          # self-update the CLI binary
```

Columns and swimlanes are referenced by name, projects by slug. Every `list`/`get` accepts `--json`. `LEXA_URL` + `LEXA_API_KEY` env vars replace the saved login.

## Environment variables

`.env.example` is the tracked dev template (copy to `.env`). The prod/staging
contract — flavors, who writes what, full variable reference — lives in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Values are generated on the machine
and never committed (`.env*` is gitignored):

| Situation | What's needed |
|---|---|
| Local dev (`.env`) | `bun run setup` generates `LXK_API_KEY` and `LXK_ADMIN_EMAILS`; `GITHUB_*` only if you want two-way GitHub sync |
| Staging/prod (`.env.staging` / `.env.prod`) | `lexa-cli deploy` prompts for admin email, API key and Cloudflare token, writes the file, and preserves `GITHUB_*` + `LXK_API_KEY` across re-runs |
| Optional | `LXK_HEARTH_DAEMON_TOKEN`, `LXK_MAX_BODY_MB` (body cap, default 16), `LOG_LEVEL` |

## Documentation

Design and API docs live in [`docs/`](docs/):

| Doc | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Big picture: stack, auth, sync, request pipeline |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | SQL schema and data invariants |
| [`docs/API.md`](docs/API.md) | REST contract |
| [`docs/LAYERS.md`](docs/LAYERS.md) | Effect service patterns, error catalog, webhook/auth flows |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deploy contract: flavors, env reference, bootstrap |
| [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md) | GitHub App setup: webhook URL/secret, private key, Access bypass |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, workflow, PR guidelines. Note: frontend work requires access to the private wireframes repo; backend/API/docs/CLI contributions are fully open.

## License

MIT — see [LICENSE](LICENSE).
