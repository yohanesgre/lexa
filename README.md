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

## CLI

`lexa-cli` wraps the REST API (`lxk_` Bearer keys): `lexa-cli login --url … --key …`, then `task|wiki|project` CRUD and `machine install|listen|start|stop|restart|status|logs|list` for Forge daemons. Dev uses `bun run lexa-cli-dev` (live repo source); prod ships a compiled binary via `bun run compile:cli` + `bun run install:cli` (→ `~/.local/bin/lexa-cli`).

## Deploying

`lexa-cli deploy <domain> [dev|staging|prod]` — Docker + cloudflared tunnel + Cloudflare Access.

## Documentation

All design and spec docs live in [`docs/`](docs/):

| Doc | Contents |
|---|---|
| [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) | Execution plan: phases, files, acceptance checks |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | SQL schema and data invariants |
| [`docs/LAYERS.md`](docs/LAYERS.md) | Effect service patterns, error catalog, webhook/auth flows |
| [`docs/API.md`](docs/API.md) | REST contract |
| [`docs/MCP.md`](docs/MCP.md) | Agent-facing MCP tool contract |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | PHOSPHOR design tokens and component specs |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Big picture and decisions log |
| [`docs/REVIEW.md`](docs/REVIEW.md) | Historical design-review record |
| [`docs/RELEASE.md`](docs/RELEASE.md) | v0.1.0 release plan and verification gates |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Security model |

`wireframes/` holds the static UI/UX source of truth (HTML previews — `bash wireframes/build.sh` rebuilds them). `AGENTS.md` is the agent rules file used by AI coding agents working on this repo.
