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
| `LXK_API_KEY` | setup wizard / `lexa-cli deploy` (or `--api-key`) | yes |
| `LXK_ADMIN_EMAILS` | setup wizard / `lexa-cli deploy` (or `--admin-email`) | yes (superadmin bootstrap, env-only) |
| `LXK_PUBLIC_URL` | `lexa-cli deploy` (from the deploy domain) | staging/prod (Better Auth baseURL) |
| `LXK_ENV` | setup wizard (`--prod`/`--staging`) / `lexa-cli deploy` | yes (prod/staging) |
| `CF_TUNNEL_TOKEN` | `lexa-cli deploy` | staging/prod |
| `GITHUB_APP_ID` / `GITHUB_WEBHOOK_SECRET` | preserved across deploys; set once by hand for issue sync | only for GitHub sync |
| `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` | hand-set; PEM volume-mounted read-only in prod compose | only for GitHub sync |
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
| `LXK_ADMIN_EMAILS` | comma-separated **superadmin** emails — env-only allow-list, applied at provisioning (setup wizard / first login); never edited at runtime |
| `LXK_API_KEY` | server auth Bearer key (`lxk_` + 43 chars) — machines only; browser key injection removed |
| `LXK_FORGE_DAEMON_TOKEN` | shared secret for Forge daemons (alternative to a Settings API key) |
| `LXK_MAX_BODY_MB` | max request body for `/api` and `/mcp` in MB (default 16); webhook payloads hard-capped at 1 MB before HMAC, regardless |
| `LXK_PUBLIC_URL` | public base URL of this flavor (e.g. `https://lexa.example.com`) — Better Auth `baseURL` + `trustedOrigins`; written by `lexa-cli deploy` from the deploy domain; hand-set in dev |
| `LXK_SEED_DEV` | dev-only boot-time sample data (`1` enables; set by `scripts/dev.sh`) |
| `PORT` | server port (default 3000) |

**Removed:** `LXK_ACCESS_AUD` / `LXK_ACCESS_TEAM` (Cloudflare Access),
`VITE_LXK_API_KEY` (browser key injection). **Never exist:** Google OAuth
envs, SMTP envs — human auth is in-app email/password (Better Auth).

## Bootstrap

**Local dev:** `bun run setup` (CLI wizard: admin email, API key, migrations,
optional sample data) then `bun run dev:full` (API :3000 + vite :5173, vite
proxies `/api` and `/mcp`). `dev:full` sets `LXK_SEED_DEV=1` for boot-time
sample data. Dev also sets `LXK_PUBLIC_URL=http://localhost:5173` (the
Better Auth base URL + cookie domain for the local flow). See the repository
README.

**Remote deploy** (no bun, no repo needed):

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/main/scripts/install-cli.sh | bash
lexa-cli deploy <domain> prod
```

The image is built and pushed by CI (`.github/workflows/publish.yml`): main →
`ghcr.io/yohanesgre/lexa:staging`, `v*` tags → `:latest` (prod). The binary
embeds the compose files (image refs, volumes, tunnel — few KB) and pulls the
image — **no checkout, no build, no git**. It checks docker/compose,
provisions Cloudflare (tunnel, DNS), writes `.env.prod`
into `~/.lexa/deploy/` (staging → `~/.lexa-staging/deploy/`), and runs
`docker compose up`. **Redeploy = upgrade**:
deploy always pulls the latest image; `--image <tag>` pins a specific version;
`--clean` recreates from scratch (removes the `lexa-data` volume — DB wiped,
confirmed on a TTY). The data volume survives normal redeploys untouched.
Non-interactive flags: `--cf-token`, `--admin-email`,
`--api-key`, `--deploy-dir`, `--image`, `--clean`. No Google/Access flags —
human auth is in-app (Better Auth).

Provisioning from a checkout instead: `bun run setup --prod --admin-email x --yes`
writes `.env.prod` with `LXK_ENV=prod`, runs migrations, mirrors the admin
email, locks setup, and seeds nothing.

**Superadmin account:** after deploy (or setup), open `/setup` once — the
wizard creates the first superadmin (email + password, email-free; the
password is never passed as a shell flag). Later allow-list edits
(`LXK_ADMIN_EMAILS`) affect only new users — set the env before first login.
Members are onboarded via superadmin-issued workspace invite links (7d
expiry) and set-password links — no email transport anywhere.

**Teardown:** `lexa-cli undeploy <domain> [staging|prod]` reverses a deploy for
that flavor: `docker compose down -v` (containers + data volume, DB wiped),
deletes the Cloudflare resources (DNS record, tunnel), and removes the local
state (flavor deploy dir + stored deploy creds; login stays). Prompts for
confirmation on a TTY; non-TTY needs `--yes`. Cloudflare steps are
best-effort — a missing token or failed API call warns and continues, so
local teardown always completes.

**GitHub sync** — see `docs/GITHUB_SETUP.md` (includes the acceptance round-trip).

## Human auth (in-app, email/password)

Human auth runs **in-process**: Better Auth 1.6.27 on the Bun server
(`server/auth.ts`), mounted at `/api/auth/*` — no Cloudflare Access, no
Google OAuth, no external IdP, no SMTP. Provisioning is the only hand step:
the `/setup` wizard (first run) creates the superadmin with a password;
`LXK_ADMIN_EMAILS` is the env-only superadmin allow-list.

### 1. Cloudflare API token

Create a token with exactly these permissions (see `lexa-cli deploy` prompt):

| Scope | Permission |
|---|---|
| Cloudflare One | Cloudflare One Connectors — **Write** |
| Zone | DNS — **Write** |

Pass it with `--cf-token <token>` or `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN`.

### 2. What `lexa-cli deploy` provisions (per flavor)

Account = the first account on the token; zone = the one matching `<domain>`.
All Cloudflare state is per-flavor (distinct names for staging vs prod):

1. **Tunnel** `lexa-staging` / `lexa-prod` — token written to `.env.<flavor>` as `CF_TUNNEL_TOKEN`
2. **DNS** — CNAME `<subdomain>.<domain>` → `<tunnel>.cfargotunnel.com` (proxied)
3. **Ingress** — `<subdomain>.<domain>` → `http://app:3000` (warns on failure; add manually via Zero Trust → Tunnels → Public Hostnames if the API call fails)

No Access apps, no IdPs, no policies — auth is in-app and needs no Cloudflare
configuration. The deploy also writes `LXK_PUBLIC_URL=https://<subdomain>.<domain>`
into the flavor env (Better Auth base URL + trusted origin).

**Security model:** `/api/*` accepts a session cookie OR a Bearer key
(dual-channel); `/mcp` and `/api/webhooks/*` are key/HMAC-only — no edge
gate exists, so there is nothing to bypass. Keys are `lxk_` + 43 base62
chars (256-bit), rate-limited per IP, and revocable per-named-key (Settings →
API Keys). Failed logins on `/api/auth/*` are throttled in-process (Better
Auth rate-limit plugin; ~5 attempts/60s per email, 15 min lockout).

Deploy creds (CF token) persist in
`~/.lexa/config.json` (staging: `~/.lexa-staging/config.json`) under the
`deploy` key.

### 3. After deploy — create the superadmin

Open `https://<subdomain>.<domain>/setup` in a browser once: the wizard
creates the first superadmin (email + password; password is never a shell
flag or env var). `LXK_ADMIN_EMAILS` must already list that email in
`.env.<flavor>` (deploy's `--admin-email` or the wizard). The wizard also
mints the machine API key and locks setup.

Subsequent humans onboard via **workspace invite links** (Settings →
Workspace → Members → Invite) and **set-password links** — both issued by a
superadmin, link-based, 7d expiry, shared out-of-band. No email transport
exists.

### 4. Verify

- Browse `https://<subdomain>.<domain>` → redirected to the in-app login page
- Sign in with the superadmin email + password → dashboard loads
- `curl https://<subdomain>.<domain>/api/health` → **200** (key-exempt probe)
- `curl -i https://<subdomain>.<domain>/api/projects` → **401** (no key, no session)
- `POST <subdomain>.<domain>/mcp` without a key → **401** from Lexa (JSON-RPC error)
- `lexa-cli login --url https://<subdomain>.<domain> --key <lxk_...>` → "Logged in" (needs a key from Settings → API Keys)
- Account menu (top right) shows the signed-in identity + **Log out**

## Secrets hygiene

- `.env`, `.env.staging`, `.env.prod` are gitignored — values are generated on
  the machine, never committed.
- `lexa-cli deploy` preserves `LXK_API_KEY` / `LXK_ADMIN_EMAILS` /
  `LXK_PUBLIC_URL` / `GITHUB_*`
  across re-runs so re-deploys don't rotate keys or clobber sync config.
- The GitHub App private key is never written to the env file: it is either
  referenced via `GITHUB_PRIVATE_KEY_FILE` or mounted read-only into the
  container (`./github-app.private-key.pem:/app/github-app.private-key.pem:ro`
  in prod compose; the PEM itself is gitignored).
