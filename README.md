# Lexa

Self-hosted project management for small teams. Kanban with swimlanes and WIP limits, rich task descriptions, a nested wiki, a Hearth AI writing assistant, and two-way GitHub issue sync.

Stack: **Bun + SQLite + TanStack Start (React) + Effect-TS + Tailwind**, served behind a cloudflared tunnel.

## Features

- **Kanban board** — swimlanes, WIP limits enforced atomically, drag-and-drop reorder, archive/restore, per-project priority/type field config
- **Tasks** — rich TipTap descriptions, assignees, activity timeline + comments, required-field gates per column, subtasks / blocked-by / related links
- **Nested wiki** — hierarchical pages, FTS5 full-text search, revisions
- **Two-way GitHub sync** — link tasks to issues, echo-suppressed webhooks, column ↔ issue-state mapping, out-of-sync surfacing
- **Hearth** — AI writing assistant with agents + skills rule bundles, pluggable runtimes (OpenCode / Hermes / Command Code)
- **Auth** — Cloudflare Access (Google OAuth) for humans, `lxk_` API keys for machines
- **`lexa-cli`** — operator CLI for tasks, wiki, deploy, and Hearth runtimes

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

`lexa-cli deploy <domain> [staging|prod]` provisions everything: Docker + cloudflared tunnel + Cloudflare Access, tunnel/DNS/ingress, Access IdP/app/policy, env file, then pulls the prebuilt image and brings up compose. The image is built and pushed by CI (`ghcr.io/yohanesgre/lexa`).

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
lexa-cli task create --project my-project --column "In Progress" --title "Ship it"
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
| Local dev (`.env`) | `bun run setup` generates `LXK_API_KEY` + `VITE_LXK_API_KEY` and `LXK_ADMIN_EMAILS`; `GITHUB_*` only if you want two-way GitHub sync |
| Staging/prod (`.env.staging` / `.env.prod`) | `lexa-cli deploy` prompts for admin email, API key and Cloudflare token, writes the file, and preserves `GITHUB_*` + `LXK_API_KEY` across re-runs |
| Optional | `LXK_HEARTH_DAEMON_TOKEN`, `LXK_MAX_BODY_MB` (body cap, default 16), `LXK_ACCESS_AUD` (Access JWT verification), `LOG_LEVEL` |

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
