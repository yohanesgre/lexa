# Deployment & Environment Contract

This doc is the single source of truth for deploying Lexa and configuring its
environment. Deployment goes through **`scripts/install.sh`** — one script,
four targets (`docker | bare | workers | dev`), zero clone for the hosted
targets. The first superadmin is provisioned **only** by the web `/setup`
wizard (email + password ≥8) — the script never handles passwords.

> Removed in cli-v2026.2.0: `lexa-cli deploy` / `lexa-cli undeploy` /
> `--runtime workers` — hard-remove, no stubs. The install script replaced
> them; `lexa-cli` is now an operate-only headless frontend (tasks, wiki,
> machines, keys, upgrades).

The working `.env*` files are **never committed** — values are generated on
the machine by the install script or the setup wizard, and all `.env*` are
gitignored. The tracked `.env.example` (repo root) is the dev template only.

## Targets

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install.sh | bash -s -- <target> [flags]
```

The installer hub serves the newest release with `BASE_URL` pinned to its
tag (see `~/projects/lexa-installer`). Pin explicitly with
`?ref=vYYYY.MINOR.MICRO`, or bypass the hub: raw
`https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/install.sh`
for a tag, or `main` for the bleeding edge.

| Target | Needs | Layout |
|---|---|---|
| `docker` | docker + compose plugin | deploy dir with compose file + `.env`; prebuilt image from `ghcr.io/yohanesgre/lexa` (default `:latest`; `--image <tag>` pins, e.g. a version tag or `staging` to track main) |
| `bare` | curl, `sha256sum`; bun auto-installed if absent | `~/.lexa-server` (release tarball, checksum-verified) + `lexa-start.sh`; `--systemd` writes + enables the `lexa` unit |
| `workers` | bun (runs `bunx wrangler`), Cloudflare API token | D1 database + R2 bucket + KV namespace provisioned, migrations applied, prebuilt Worker bundle deployed (`scripts/workers-install.ts`) |
| `dev` | git + bun | clones the repo into `./lexa`, `bun install`, `bun run setup`, `bun run dev:full` |

Flags: `--ref <tag|branch>` (script + artifact source: a release tag or
`main`), `--name <name>` (workers deploy name, default `lexa`),
`--port` (docker, default
8080), `--bind` (default 127.0.0.1), `--domain` (workers custom domain; skips the prompt),
`--systemd` (bare), `--image <tag>` (docker), `--from-repo <dir>` (install
from a local checkout), `--yes`.

The docker target uses direct semantics — host port mapping, no tunnel. Put
your own reverse proxy in front of `<bind>:<port>` to reach it over TLS.

### Cloudflare Workers target

- **Custom domain:** interactive runs always offer the prompt (Enter =
  free `lexa.<account>.workers.dev` subdomain); `--domain lexa.example.com`
  skips it (zone-validated at provision time).
- **Cloudflare token:** `CF_API_TOKEN` env or prompt (Workers scripts, D1,
  R2, KV permissions). Provisioning is find-or-create — re-runs reuse the
  existing D1/R2/KV resources and apply migrations incrementally.
- No tunnel, no VPS: the Worker route (custom domain or workers.dev) is the
  public entry. See `docs/CLOUDFLARE_WORKERS.md` for runtime details.
- **Zero-file alternative (DRAFT-UNVERIFIED):** Deploy Button (one click,
  no CLI — see below) or manual dashboard clicks
  (`docs/DEPLOYMENT_DASHBOARD.md`). Same bindings, same migrations,
  no secrets to paste — machine keys are minted post-setup.

### Deploy Button — Cloudflare dashboard (DRAFT-UNVERIFIED)

> Not yet click-tested on a live account. Steps below follow the
> Cloudflare Deploy Button contract (reads `wrangler.jsonc`, provisions
> D1/R2/KV, runs the repo `build` + `deploy` scripts). Report mismatches.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yohanesgre/lexa)

1. Click the button → Cloudflare forks the repo into your account and
   provisions D1 (`lexa`), R2 (`lexa-blobs`), KV from `wrangler.jsonc`.
2. Build command: `LEXA_FLAVOR=workers vite build`
   (repo script: `build:workers`). Deploy command: `deploy:workers`
   (`wrangler d1 migrations apply DB --remote && wrangler deploy`).
3. No secrets to fill — deploy with everything blank.
4. Open `<worker>.workers.dev/setup` → create the superadmin.
   The first superadmin locks setup; mint machine keys via
   login → Settings → API Keys (or `lexa-cli login` device flow).
5. **REQUIRED tail — disable auto-deploy:** the Button wires Workers
   Builds (deploy on every push to your fork). Open the Worker →
   Settings → Builds → pause/disable automatic deployments (or set the
   deploy command to a versions upload). Your fork is then a manual
   snapshot: update = sync upstream + click Deploy. Never auto.
6. One DB, one method: a database deployed by the Button (wrangler
   `d1_migrations` journal) must keep deploying that way; a database
   deployed by `install.sh workers` (`_migrations` journal) the other.
   Mixing methods double-applies migrations.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/uninstall.sh | bash -s -- <target>
```

Data is **kept** unless `--purge` (requires typing `purge` on a TTY): docker
removes the compose project but keeps the `lexa-data` volume; bare keeps the
install dir; workers keeps D1/R2/KV; dev keeps `data/`. The CLI itself is
uninstalled manually (`rm $(which lexa-cli)`).

## Upgrade

**Re-run `install.sh` from the new release tag — that is the whole upgrade.**
The script is idempotent: docker pulls the new image and recreates the
container (`lexa-data` volume survives); bare fetches the new tarball and
restarts; workers reuses the Cloudflare resources and applies only new
migrations. DB migrations run at server boot.

Workers upgrades resume the previous deploy: run from the same directory,
and the domain defaults to the last one (Enter keeps it); the token is
reused from `CF_API_TOKEN`, `--cf-token`, or the saved `.cf-token` file
(offered after TTY entry, `chmod 600`, never written from env/flag values).
Only the 2 newest release tarballs are kept; starting in a directory with
no previous deploy asks for confirmation first. On a shared machine,
decline the token-save offer.

## Sample data

Sample data is offered in every environment: the web wizard shows the
sample-data step on local installs, `/api/setup/seed` has no environment
gate, and `bun run setup` offers it interactively. The Backlog swimlane and
default columns appear when the first project is created.

## Who writes what

| Variable | Written by | Required |
|---|---|---|
| `API keys (lxk_...)` | minted post-setup via login session (Settings → API Keys, or `lexa-cli login` device flow) | only for machines (CLI/daemons/scripts) |
| `LXK_ENV` | install script / setup wizard | yes (`production` on deployed targets) |
| `LXK_PUBLIC_URL` | install script (from `--bind`/`--port`/`--domain`) | deployed targets (Better Auth baseURL) |
| `CF_API_TOKEN` | operator env (workers target only) | workers only |
| `LXK_ADMIN_EMAILS` | setup wizard (dev bootstrap) | dev only |
| `GITHUB_APP_ID` / `GITHUB_WEBHOOK_SECRET` | hand-set once for issue sync; preserved across re-runs | only for GitHub sync |
| `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` | hand-set; PEM volume-mounted read-only in prod compose | only for GitHub sync |
| `LXK_HEARTH_DAEMON_TOKEN` | hand-set (Settings alternative) | only for Hearth daemons |
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
| `LXK_ADMIN_EMAILS` | comma-separated **superadmin** emails — env-only allow-list, applied at provisioning (dev setup wizard only); never edited at runtime |
| `LXK_API_KEY` | REMOVED — no longer provisioned or read. Pre-change installs keep their DB-seeded row; fresh installs mint user-bound keys post-setup. |
| `LXK_HEARTH_DAEMON_TOKEN` | shared secret for Hearth daemons (alternative to a Settings API key) |
| `LXK_MAX_BODY_MB` | max request body for `/api` in MB (default 16); webhook payloads hard-capped at 1 MB before HMAC, regardless |
| `LXK_PUBLIC_URL` | public base URL of this install (e.g. `https://lexa.example.com`) — Better Auth `baseURL` + `trustedOrigins`; written by the install script; hand-set in dev |
| `LXK_SEED_DEV` | dev-only boot-time sample data (`1` enables; set by `scripts/dev.sh`) |
| `PORT` | server port (default 3000) |

**Unused by the server:** `LXK_ACCESS_AUD` / `LXK_ACCESS_TEAM` (Cloudflare
Access) — the server reads them nowhere. Browsers authenticate via the
session cookie.
**Never exist:** Google OAuth envs, SMTP envs — human auth is in-app
email/password (Better Auth).

## Bootstrap

**Local dev:** `bun run setup` (dev-only CLI wizard: admin email, API key,
migrations, optional sample data — self-hosters use the install script +
`/setup` wizard instead) then `bun run dev:full` (API :3000 + vite :5173,
vite proxies `/api`). `dev:full` sets `LXK_SEED_DEV=1` for boot-time sample
data. Dev also sets `LXK_PUBLIC_URL=http://localhost:5173` (the Better Auth
base URL + cookie domain for the local flow). See the repository README.

**Superadmin account:** after install, open `<url>/setup` once — the wizard
creates the first superadmin (free-choice email + password; the password is
never passed as a shell flag or env var). Members are onboarded via
superadmin-issued workspace invite links (7d expiry) and set-password links —
no email transport anywhere.

**Verify:**

- Browse the deployed URL → redirected to the in-app login page
- Sign in with the superadmin email + password → dashboard loads
- `curl <url>/api/health` → **200** (key-exempt probe)
- `curl -i <url>/api/projects` → **401** (no key, no session)
- `lexa-cli login --url <url>` → browser-approval device flow mints a key
  ("Logged in"; headless scripts use a key from Settings → API Keys)

**GitHub sync** — see `docs/GITHUB_SETUP.md` (includes the acceptance round-trip).

## Security notes

- **Pipe per-tag URLs.** Always pipe the install/uninstall script from a
  pinned release tag (`…/v2026.1.2/scripts/install.sh`), never `main` — the
  script content cannot change between your read and your run. Bare-metal
  tarballs are additionally sha256-verified by the script.
- `.env*` files are gitignored — values are generated on
  the machine, never committed. The install script preserves `GITHUB_*`
  across re-runs so upgrades don't clobber sync config (DB-minted API keys
  survive in the data volume / D1).
- The GitHub App private key is never written to the env file: it is either
  referenced via `GITHUB_PRIVATE_KEY_FILE` or mounted read-only into the
  container (`./github-app.private-key.pem:/app/github-app.private-key.pem:ro`
  in prod compose; the PEM itself is gitignored).
- `/api/*` accepts a session cookie OR a Bearer key (dual-channel);
  `/api/webhooks/*` is HMAC-only. Keys are `lxk_` + 43 base62 chars
  (256-bit), rate-limited per IP, revocable per-named-key (Settings → API
  Keys). Failed logins on `/api/auth/*` are throttled in-process (Better Auth
  rate-limit plugin; ~5 attempts/60s per email, 15 min lockout).

## Upgrading across the Forge→Hearth rename (2026-08-24)

> Pre-release history: migrations `0001`–`0024` were squashed into a single
> `0001_init.sql` baseline for 2026.1.0 (no tagged release predates it, so no
> live database carries the old files). The rename below describes what the
> baseline already contains; fresh installs get it directly.

The baseline carries the renamed DB tables and activity types (`hearth_*`);
the server image applies it at boot. Machines running the old listener/daemon
must be reinstalled — the systemd unit (`lexa-hearth-listen`), state dir
(`~/.local/share/lexa-hearth`), env vars (`HEARTH_*`,
`LXK_HEARTH_DAEMON_TOKEN`) and auth header (`x-hearth-token`) all changed:

```bash
lexa-cli machine uninstall && lexa-cli machine install
```

Old daemons sending `x-forge-token` or polling `/api/forge/*` get 401/404
after the server upgrade — upgrade the server first, then reinstall machines.
