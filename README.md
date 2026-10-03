# Lexa

Self-hosted project management for small teams. Kanban with swimlanes and WIP limits, rich task descriptions, a nested wiki, milestones, an AI Assistant, team auth, and two-way GitHub issue sync.

Stack: **Bun + SQLite + TanStack Start (React) + Effect-TS + Tailwind**. Self-hosted on Cloudflare Workers (D1 + R2 + KV) via `scripts/install.sh`; local dev runs the Bun + SQLite flavor.

**Deploy target:** Cloudflare Workers is the only target — `scripts/install.sh`
provisions D1 + R2 + KV and deploys the prebuilt Worker
(`docs/DEPLOYMENT.md`). The AI Assistant is Workers-only.

## Features

- **Kanban board** — swimlanes (Backlog + sprints), WIP limits enforced atomically, drag-and-drop reorder, archive/restore, per-project priority/type field config, required-field gates, stable ticket keys
- **Tasks** — rich TipTap descriptions, assignees, activity timeline + comments, attachments, subtasks / blocked-by / related links, GitHub issue links with sync status
- **Nested wiki** — hierarchical pages, FTS5 full-text search, revisions with restore, public share links
- **Milestones** — goals above sprints with target dates, progress tracking, timeline gantt
- **AI Assistant** (Cloudflare Workers deploy only) — streaming chat with threads, document Generate with review-in-editor, a multi-provider gateway, builtin agent + skills rule bundles, and a proposed-actions approval flow for task/wiki writes
- **Auth & teams** — email/password login with cookie sessions, teams and roles, workspace invites, `lxk_` API keys for scripts and the CLI
- **Two-way GitHub sync** — link tasks to issues, echo-suppressed webhooks, column ↔ issue-state mapping, out-of-sync surfacing
- **`lx`** — headless operator CLI for tasks, wiki, projects, GitHub status, and upgrades; also the integration surface for external agents

## Quickstart (local dev)

Requires [Bun](https://bun.sh) — dev runs the Cloudflare Workers flavor locally
(workerd via the Cloudflare Vite plugin, local D1/R2/KV bindings).

```bash
bun install
bun run setup          # first-time: admin email, migrations, sample data
bun run dev            # derive .dev.vars + apply local D1 migrations + vite dev
# open http://localhost:5173
```

- Local D1/R2/KV state lives under `.wrangler/state/` — delete it to start fresh.
- Health check: `curl http://localhost:5173/api/health`
- First-run web wizard at `/setup` (fresh installs only).

### Verification

```bash
tsc --noEmit
vitest run
```

## Deploying (self-host)

One install script — no clone, no repo checkout:

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install.sh | bash -s -- workers
```

The installer hub serves the newest release (pin with `?ref=vYYYY.MINOR.MICRO`,
or use a raw `.../lexa/<tag>/scripts/install.sh` URL for a tag). The only target
is `workers`: Cloudflare Workers + D1 + R2 + KV via `bun x wrangler`, installed
into `cf-workers/` in the current directory — or zero-file:
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yohanesgre/lexa)
(DRAFT-UNVERIFIED, see `docs/DEPLOYMENT.md`; disable Builds auto-deploy after).

Flags: `--ref <tag>`, `--name <name>` (deploy name), `--account <id>`,
`--domain <domain>` (custom domain), `--cf-token <token>`, `--secrets-file <path>`,
`--reset-db`, `--from-repo <dir>`, `--yes`. Full contract:
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**First run:** open `<worker-url>/setup` — create the first admin (email +
password, min 8 chars). The wizard is the **only** provisioning path; passwords
never pass through the shell.

**lx** is the headless operator frontend for the running server (tasks, wiki,
projects, GitHub status, keys, upgrades) — it installs separately and has **no
deploy commands** (removed in cli-v2026.2.0; self-hosting is
`scripts/install.sh`):

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install-cli.sh | bash
```

**Uninstall** (Worker deleted; D1/R2/KV kept):

```bash
curl -fsSL https://install.yohanesgre.com/lexa/uninstall.sh | bash -s -- workers
```

- **Upgrade = re-run `install.sh`** from the new tag (idempotent; data survives)
- Full contract (target details, env reference, security notes):
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
- `lx task list|get|create|move|update` and `lx wiki list|get` are the
  supported integration surface for external harnesses. Nothing else is
  API-stable; there is no agent-runtime/machine listener to install.

## Environment variables

`.env.toml` is the canonical config file; `.env.toml.example` is the tracked
template (copy it and edit). `bun run setup` writes `.env.toml` for you.
Precedence is **real environment → `.env.toml` → legacy `.env` → defaults**:
a flat `.env` from an earlier release is still read for one release, and
migrating renames it to `.env.legacy`. The self-hosting contract — target
layout, env reference, security notes, upgrade steps — lives in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). On Workers the app reads bindings
and secrets (`wrangler.jsonc` + `wrangler secret put`); the custody file
`cf-workers/.env.toml` holds the envelope key. Working env files are generated
on the machine and never committed (`.env*` is gitignored; `.env.toml.example`
is the one tracked exception):

| Situation | What's needed |
|---|---|
| Local dev (`.env.toml`) | `bun run setup` writes it and records `LXK_ADMIN_EMAILS`; API keys minted post-setup; GitHub sync configured in the web app |
| Self-hosted (install script) | the script writes `cf-workers/.env.toml` (0600) as custody for `LXK_SECRETS_MASTER_KEY` and pushes it to the Worker as a secret; D1/R2/KV are provisioned under `--name`. API keys minted post-setup (login → Settings → API Keys); the master key is preserved across re-runs |
| Optional | `LXK_ASSISTANT_REPO_CAP` (Workers-only assistant repo-grounding cap, default 3), `LXK_MAX_BODY_MB` (body cap, default 16), `LOG_LEVEL` |

## Documentation

Design and API docs live in [`docs/`](docs/):

| Doc | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Big picture: stack, auth, sync, request pipeline |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | SQL schema and data invariants |
| [`docs/API.md`](docs/API.md) | REST contract |
| [`docs/LAYERS.md`](docs/LAYERS.md) | Effect service patterns, error catalog, webhook/auth flows |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Self-hosting via install.sh: the Workers target, env reference, bootstrap |
| [`docs/CLOUDFLARE_WORKERS.md`](docs/CLOUDFLARE_WORKERS.md) | Workers runtime: D1/R2/KV bindings, quirks, cron |
| [`docs/GITHUB_SETUP.md`](docs/GITHUB_SETUP.md) | GitHub App setup: webhook URL/secret, private key |
| [`docs/RELEASING.md`](docs/RELEASING.md) | Release policy, pre-tag checklist, CLI build flow |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, workflow, PR guidelines. Note: frontend work requires access to the private wireframes repo; backend/API/docs/CLI contributions are fully open.

## License

MIT — see [LICENSE](LICENSE).
