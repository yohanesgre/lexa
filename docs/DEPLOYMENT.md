# Deployment & Environment Contract

This doc is the single source of truth for the environment configuration of a
Lexa deployment. The working `.env*` files are **never committed** — values
are generated on the machine by the setup wizard (`bun run setup`) or by
`lexa-cli deploy`, and all `.env*` are gitignored. The tracked
`.env.example` (repo root) is the dev template only; prod/staging values are
documented here.

## Flavors

| Flavor | Env file | `LXK_ENV` | Compose files | Subdomain | Tunnel |
|---|---|---|---|---|---|
| dev (local) | `.env` | `dev` | `docker-compose.yml` | — | none |
| staging | `.env.staging` | `staging` | `docker-compose.yml` + `docker-compose.staging.yml` | `lexa-preview.<domain>` | `lexa-staging` |
| prod | `.env.prod` | `prod` | `docker-compose.yml` + `docker-compose.prod.yml` | `lexa.<domain>` | `lexa-prod` |

`LXK_ENV` is the seed gate: when set and not `dev`, sample data is refused at
three layers — the `/api/setup/seed` endpoint, the CLI wizard, and the web
wizard's sample-data step. Prod/staging stay empty; the Backlog swimlane and
default columns appear when the first project is created (project-creation
logic, not seed).

## Who writes what

| Variable | Written by | Required |
|---|---|---|
| `LXK_API_KEY` / `VITE_LXK_API_KEY` | setup wizard / `lexa-cli deploy` (or `--api-key`) | yes |
| `LXK_ADMIN_EMAILS` | setup wizard / `lexa-cli deploy` (or `--admin-email`) | yes |
| `LXK_ENV` | setup wizard (`--prod`/`--staging`) / `lexa-cli deploy` | yes (prod/staging) |
| `CF_TUNNEL_TOKEN` | `lexa-cli deploy` | staging/prod |
| `GITHUB_APP_ID` / `GITHUB_WEBHOOK_SECRET` | preserved across deploys; set once by hand for issue sync | only for GitHub sync |
| `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` | hand-set; PEM volume-mounted read-only in prod compose | only for GitHub sync |
| `LXK_ACCESS_AUD` | hand-set after deploy (Access audience tag) | staging/prod with Access JWT verification |
| `LXK_ACCESS_TEAM` | hand-set | only for the Access logout link |
| `LXK_FORGE_DAEMON_TOKEN` | hand-set (Settings alternative) | only for Forge daemons |
| `LXK_MAX_BODY_MB` / `LOG_LEVEL` / `DATABASE_PATH` / `PORT` | defaults; tune by hand | no |

## Full variable reference

| Variable | Meaning |
|---|---|
| `COMPOSE_PROJECT_NAME` | docker compose project name (dev flavor) — not read by the app |
| `DATABASE_PATH` | SQLite file path (default `./data/lexa.db`; `/app/data/lexa.db` in compose) |
| `GITHUB_APP_ID` | GitHub App id for two-way issue sync |
| `GITHUB_PRIVATE_KEY` | App private key inline (escaped `\n`) — wins over `_FILE` |
| `GITHUB_PRIVATE_KEY_FILE` | App private key file path (read at boot, no escaping — recommended) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for the `/api/webhooks/github` route |
| `LOG_LEVEL` | logging level (default `info`) |
| `LXK_ACCESS_AUD` | Cloudflare Access audience tag (`https://<team>.cloudflareaccess.com/cdn-cgi/access/get-ksi`). When set, `/api` and `/mcp` require valid Access JWTs; otherwise only API keys are checked |
| `LXK_ACCESS_TEAM` | Access team subdomain — enables the "Sign out" (Access logout) link in the UI |
| `LXK_ADMIN_EMAILS` | comma-separated admin emails (env OR `settings.admin_emails` is checked) |
| `LXK_API_KEY` | server auth Bearer key (`lxk_` + 43 chars) |
| `LXK_FORGE_DAEMON_TOKEN` | shared secret for Forge daemons (alternative to a Settings API key) |
| `LXK_MAX_BODY_MB` | max request body for `/api` and `/mcp` in MB (default 16); webhook payloads hard-capped at 1 MB before HMAC, regardless |
| `LXK_SEED_DEV` | dev-only boot-time sample data (`1` enables; set by `scripts/dev.sh`) |
| `PORT` | server port (default 3000) |
| `VITE_LXK_API_KEY` | browser-side key, injected into the served HTML at runtime |

## Bootstrap

**Local dev:** `bun run setup` (CLI wizard: admin email, API key, migrations,
optional sample data) then `bun run dev:full` (API :3000 + vite :5173, vite
proxies `/api` and `/mcp`). `dev:full` sets `LXK_SEED_DEV=1` for boot-time
sample data. See the repository README.

**Remote deploy** (no bun, no repo needed):

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
lexa-cli deploy <domain> prod
```

The image is built and pushed by CI (`.github/workflows/publish.yml`): main →
`ghcr.io/yohanesgre/lexa:staging`, `v*` tags → `:latest` (prod). The binary
embeds the compose files (image refs, volumes, tunnel — few KB) and pulls the
image — **no checkout, no build, no git**. It checks docker/compose,
provisions Cloudflare (tunnel, DNS, Access, Google IdP), writes `.env.prod`
into `~/.lexa/deploy/`, and runs `docker compose up`. **Redeploy = upgrade**:
deploy always pulls the latest image; `--image <tag>` pins a specific version;
`--clean` recreates from scratch (removes the `lexa-data` volume — DB wiped,
confirmed on a TTY). The data volume survives normal redeploys untouched.
Non-interactive flags: `--cf-token`, `--google-client-id`,
`--google-client-secret`, `--team-domain`, `--email-domain`, `--admin-email`,
`--api-key`, `--deploy-dir`, `--image`, `--clean`.

Provisioning from a checkout instead: `bun run setup --prod --admin-email x --yes`
writes `.env.prod` with `LXK_ENV=prod`, runs migrations, mirrors the admin
email, locks setup, and seeds nothing.

**GitHub sync** — see `docs/GITHUB_SETUP.md` (includes the acceptance round-trip).

## Secrets hygiene

- `.env`, `.env.staging`, `.env.prod` are gitignored — values are generated on
  the machine, never committed.
- `lexa-cli deploy` preserves `LXK_API_KEY` / `LXK_ADMIN_EMAILS` / `GITHUB_*`
  across re-runs so re-deploys don't rotate keys or clobber sync config.
- The GitHub App private key is never written to the env file: it is either
  referenced via `GITHUB_PRIVATE_KEY_FILE` or mounted read-only into the
  container (`./github-app.private-key.pem:/app/github-app.private-key.pem:ro`
  in prod compose; the PEM itself is gitignored).
