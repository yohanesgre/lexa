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

The canonical config file is **`.env.toml`**. It is structured TOML where the
sections (`[core]`, `[auth]`, `[github]`, …) are presentation only and every
leaf key is the env-var name verbatim (`DATABASE_PATH`, `LXK_*`, `GITHUB_*`,
`TYPESAFE_*`). Working env files are **never committed** — values are generated
on the machine by the install script or the setup wizard, and all working
`.env*` files are gitignored. The tracked `.env.toml.example` (repo root) is the
dev + reference template; `.env.toml` itself is written by `bun run setup` (0600).

The loader is `server/env-file.ts` — a plain module with a CLI. `server/entry.ts`
calls `applyEnvFile()` at boot, `scripts/dev.sh` evals
`bun server/env-file.ts --export-shell`, and `bun run setup` writes the file.
**Real environment variables always win** over file values; the loader never
overwrites an already-set variable.

Precedence: **real env → `.env.toml` → legacy `.env` → defaults.** A flat `.env`
is deprecated: it is still read as a one-release fallback, and migration
(`bun server/env-file.ts --migrate`, or `bun run setup`'s auto-migration)
converts it to `.env.toml` and renames the original to `.env.legacy` (0600).

> **Installer (shipped):** the installer writes `.env.toml` for the docker /
> bare / systemd targets. The container bind-mounts it read-only
> (`create_host_path: false`, so a missing file fails the start instead of
> silently creating a directory) and the app applies it at boot; bare and
> systemd run `bun server/entry.ts` from the install directory, so the loader
> finds `.env.toml` there (no `--env-file`). The flat `.env` holds
> compose-tooling variables only: `LXK_IMAGE_TAG`, plus `CF_TUNNEL_TOKEN` when a
> tunnel is configured. An operator-set `COMPOSE_PROJECT_NAME` is preserved but
> the installer never writes it (setting it would rename the compose project and
> orphan the `lexa-data` volume). Re-runs **merge** — operator-added keys such as
> `GITHUB_*`, `LXK_MCP_MASTER_KEY`, and a pinned `LXK_IMAGE_TAG` are preserved
> (previously the flat `.env` was truncated). The installer reads the image's
> own uid:gid (never a hardcode) and re-owns `.env.toml` to
> `host-uid:<image-gid>` mode 0640 (a root installer uses
> `<image-uid>:<image-gid>`) so the container process can read the mount. A
> resolved `.env.toml` that exists but cannot be read or parsed fails the boot
> (exit non-zero, path named) instead of silently starting on defaults; only a
> genuinely absent file warns and falls back.

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
| `docker` | docker + compose plugin | deploy dir with compose file + canonical `.env.toml` (plus a tooling-only flat `.env` for compose); prebuilt image from `ghcr.io/yohanesgre/lexa` (default `:latest`; `--image <tag>` writes `LXK_IMAGE_TAG`, e.g. a version tag or `staging` to track main) |
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
   login → Settings → API Keys (or `lx login` device flow).
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
uninstalled manually (`rm $(which lx)`).

## Upgrade

**Re-run `install.sh` from the new release tag — that is the whole upgrade.**
The script is idempotent: docker pulls the new image and recreates the
container (`lexa-data` volume survives); bare fetches the new tarball and
restarts; workers reuses the Cloudflare resources and applies only new
migrations. DB migrations run at server boot. Env writes merge: a legacy flat
`.env` is converted to `.env.toml` in place (original kept as `.env.legacy`)
and operator-added keys are preserved, so a pre-P4 install upgrades cleanly.

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

`bun run setup` (via `server/env-file.ts`) writes `.env.toml` at 0600, merging
into any existing file. The loader applies `.env.toml` (or a legacy `.env`) at
boot and never overwrites a variable already set in the real environment. Setup
and `--local` CLI writes preserve `GITHUB_*` / `LXK_MCP_MASTER_KEY` across
re-runs.

| Variable | Written by | Required |
|---|---|---|
| `API keys (lxk_...)` | minted post-setup via login session (Settings → API Keys, or `lx login` device flow) | only for non-browser clients (CLI/scripts) |
| `LXK_ENV` | install script / setup wizard | yes (`production` on deployed targets) |
| `LXK_PUBLIC_URL` | install script (from `--bind`/`--port`/`--domain`) | deployed targets (Better Auth baseURL) |
| `CF_API_TOKEN` | operator env (workers target only) | workers only |
| `LXK_ADMIN_EMAILS` | setup wizard (dev bootstrap) | dev only |
| `GITHUB_APP_ID` / `GITHUB_WEBHOOK_SECRET` | hand-set once for issue sync; preserved across install-script re-runs (the installer merges, never truncates) | only for GitHub sync |
| `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` | hand-set; PEM volume-mounted read-only in prod compose | only for GitHub sync |
| `LXK_ASSISTANT_REPO_CAP` | hand-set (only to override the default repo-content cap) | no |
| `LXK_TRUSTED_PROXY_CIDRS` | hand-set (only when a non-loopback proxy fronts the API) | no |
| `LXK_MAX_BODY_MB` / `LOG_LEVEL` / `DATABASE_PATH` / `PORT` | defaults; tune by hand | no |
| `LXK_MCP_MASTER_KEY` | hand-set (or `wrangler secret put` on Workers); preserved across install-script re-runs like `GITHUB_*` | no — but **required to store an MCP token**; unset allows only secret-less MCP clients |

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
| `LXK_ASSISTANT_REPO_CAP` | cap on source-role repos used as assistant grounding context (default 3) |
| `LXK_RUNTIME_DAEMON_TOKEN` | REMOVED (agent-runtime tier deleted, migration `0008`) — no longer read; leaving it set is harmless, remove it at your convenience |
| `LXK_MAX_BODY_MB` | max request body for `/api` in MB (default 16); webhook payloads hard-capped at 1 MB before HMAC, regardless |
| `LXK_MCP_MASTER_KEY` | **required to store an MCP client token** — the token is the only credential source since 2026-09-28 (`env:`/`file:` references were removed). Base64 of **exactly 32 bytes** (base64url is accepted too; `openssl rand -base64 32`). **Unset → token storage is disabled**: a save carrying a token is refused with 400 `MCP_INVALID_TRANSPORT_CONFIG`, a secret-less client is still legal, and a client with an already-stored token keeps its stored value (never silently dropped). Set it in the server environment, never in the database, never in a response or a log, and never commit it. Rotating: set `LXK_MCP_MASTER_KEY_PREV` to the **old** value, `LXK_MCP_MASTER_KEY` to the **new** one, restart, then re-enter tokens in the webapp over time — existing rows stay readable through the PREV slot, so there is no outage and no rewrap step. |
| `LXK_MCP_MASTER_KEY_PREV` | **optional, read-only** — the previous `LXK_MCP_MASTER_KEY`, same 32-byte base64 shape. It is the rotation *read* path only: rows encrypted under the old slot (`key_id = 'prev'`) keep resolving, and any token entered while it is set is encrypted under the **active** key. Remove it once every row is re-entered (an unfinished rotation is a warning, not a break). |
| `LXK_PUBLIC_URL` | public base URL of this install (e.g. `https://lexa.example.com`) — Better Auth `baseURL` + `trustedOrigins`; written by the install script; hand-set in dev |
| `LXK_SEED_DEV` | dev-only boot-time sample data (`1` enables; set by `scripts/dev.sh`) |
| `LXK_TRUSTED_PROXY_CIDRS` | comma-separated IPv4/IPv6 CIDRs or bare IPs of reverse proxies allowed to contribute a trusted `cf-connecting-ip` header to rate limiting. **Unset/empty → loopback only** (`127.0.0.0/8`, `::1`, and the v4-mapped form) — correct when cloudflared or another sidecar connects from this host. Set it when the proxy is a separate container/host reachable over a private network (e.g. `172.16.0.0/12`, `10.0.0.0/8`). A peer that is neither loopback nor listed here has its forwarding header **ignored** (the socket/stamped IP is used), so a direct client cannot spoof its way into a fresh bucket. Malformed entries are ignored; the key is never a boot failure. |
| `PORT` | server port (default 3000) |
| `TYPESAFE_API_KEY` | Typesafe Jev API key for the System 1 advisory layer. **Unset → Jev is disabled**: no Jev request is made and the assistant behaves exactly as before. Hand-set only; never logged, never written into a tool argument, prompt, or response. A set key enables the whole layer (`server/assistant/jev.ts`): one bounded REST preflight per new chat or task-assistant run, plus the read-only `jev_assess` tool for follow-up judgments. Both are advisory and fail open, so a Jev failure leaves the assistant run unchanged. When the key is set, the preflight runs ahead of the provider call and can add up to 3s (`JEV_PREFLIGHT_TIMEOUT_MS`) to first-token latency on a new run. |
| `TYPESAFE_BASE_URL` | Jev API origin (default `https://api.typesafe.ai`); requests go to `{TYPESAFE_BASE_URL}/v1/systemone`. Only change it for a self-hosted or proxied endpoint. |
| `TYPESAFE_DEFAULT_MODEL` | Jev model id (default `jev-latest`). |

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
- `lx login --url <url>` → browser-approval device flow mints a key
  ("Logged in"; headless scripts use a key from Settings → API Keys)

**GitHub sync** — see `docs/GITHUB_SETUP.md` (includes the acceptance round-trip).

## Security notes

- **Pipe per-tag URLs.** Always pipe the install/uninstall script from a
  pinned release tag (`…/v2026.1.2/scripts/install.sh`), never `main` — the
  script content cannot change between your read and your run. Bare-metal
  tarballs are additionally sha256-verified by the script.
- `.env.toml` (and any legacy `.env*`) is gitignored — values are generated on
  the machine, never committed. Re-running the install script **merges** into
  `.env.toml`: installer-owned keys are rewritten, operator-added keys
  (`GITHUB_*`, `LXK_MCP_MASTER_KEY`, …) are preserved. DB-minted API keys
  survive in the data volume / D1.
- The GitHub App private key is never written to the env file: it is either
  referenced via `GITHUB_PRIVATE_KEY_FILE` or mounted read-only into the
  container (`./github-app.private-key.pem:/app/github-app.private-key.pem:ro`
  in prod compose; the PEM itself is gitignored).
- `/api/*` accepts a session cookie OR a Bearer key (dual-channel);
  `/api/webhooks/*` is HMAC-only. Keys are `lxk_` + 43 base62 chars
  (256-bit), rate-limited per IP, revocable per-named-key (Settings → API
  Keys). Failed logins on `/api/auth/*` are throttled in-process (Better Auth
  rate-limit plugin; ~5 attempts/60s per email, 15 min lockout).
- `TYPESAFE_API_KEY` is a third-party credential held the same way as the
  GitHub key: set by hand (or `wrangler secret put` on Workers), never
  committed, never logged. The Jev client logs nothing itself and returns only
  a typed outcome — a request's state text and the key are absent from every
  failure message, and the stderr log line carries only `mode`, `outcome`,
  `code`, `latencyMs`, and returned `usage` — never state text.
- `LXK_MCP_MASTER_KEY` (and its read-only `LXK_MCP_MASTER_KEY_PREV`) is the
  envelope key for managed MCP client tokens — the only credential source since
  2026-09-28, so the key is **required to store a token** (secret-less clients
  stay legal). It is set by hand in the server environment (or
  `wrangler secret put` on Workers — see `docs/CLOUDFLARE_WORKERS.md`), **never
  committed, never written into a committed `.env.toml` or into a log line**,
  and it is the one value that must not travel with a backup: the DB stores
  ciphertext, so a backup without the key is inert. Keeping them apart is what
  makes the ciphertext worth storing — see `docs/BACKUPS.md`.

## Upgrading to `.env.toml` (2026-09-29)

`.env.toml` is now the canonical config file. A flat `.env` is still read as a
one-release fallback — precedence is real env → `.env.toml` → legacy `.env` →
defaults — so existing installs keep booting unchanged.

1. **Convert the file (recommended, one command).** From the directory that
   holds your `.env`:
   ```bash
   bun server/env-file.ts --migrate            # add --dry-run to preview
   ```
   It writes `.env.toml` (0600), verifies a byte-exact round-trip, then renames
   the original to `.env.legacy` (0600). `bun run setup` does the same
   automatically (interactive confirm; `--migrate-env` for non-interactive),
   and `setup --env-file <path>.toml` writes TOML directly. Dead keys
   (`LXK_API_KEY`, `VITE_LXK_API_KEY`, `RUNTIME_*`, `LXK_ACCESS_*`) are dropped
   rather than carried.
2. **Rollback** — nothing is destructive: restore the legacy file and remove the
   new one.
   ```bash
   rm .env.toml && mv .env.legacy .env
   ```
3. **Installer targets (docker / bare / systemd): just re-run the installer.**
   It migrates a pre-existing flat `.env` in the deploy/install dir to
   `.env.toml` (keeping the original as `.env.legacy`) and then merges its own
   keys in; the container bind-mounts it read-only and a bare host loads it from
   the install directory. No manual conversion needed, and operator-added keys
   (`GITHUB_*`, `LXK_MCP_MASTER_KEY`, …) plus a pinned `LXK_IMAGE_TAG` are
   preserved. Rollback requires re-running the installer: restore `.env.legacy`
   to `.env`, remove `.env.toml`, then re-run so the tooling `.env` and compose
   file are regenerated.
4. **Permissions** — `.env.toml` is written 0600 on bare/systemd and 0640
   (`host-uid:<image-gid>`, derived from the image; a root installer uses
   `<image-uid>:<image-gid>`) on docker so the container process can read it; it
   stays gitignored (`.env.toml.example` is the only tracked env file).

## Upgrading across managed-only MCP client secrets (2026-09-28)

MCP client credentials became managed-only: the `env:NAME` / `file:/abs/path`
reference source and its allowlist/denylist were removed, and
`LXK_MCP_MASTER_KEY` is now required to store a token (secret-less clients stay
legal). See `docs/ARCHITECTURE.md` §Managed-only MCP client secrets.

1. **Migration ordering matters.** Boot applies
   `0012_remove_mcp_secret_refs.sql`, which clears every stored `secret_ref`
   with a single value `UPDATE` (no DDL, no FK interaction; idempotent).
   Upgrade the build and run migrations together, or run
   `wrangler d1 migrations apply` before the new Worker starts. An **old build
   on an un-migrated database** can still resolve a stored ref; the **new build
   refuses a stored ref** at connect (`MCP_CONNECT_FAILED`) until a write
   clears it — never an anonymous connect.
2. **Stored references stop authenticating.** Any client that used `env:` /
   `file:` must have a Bearer token **entered** in the webapp instead (Settings
   → Assistant → MCP Clients), which needs `LXK_MCP_MASTER_KEY` set. The token
   is stored encrypted and the legacy ref is cleared on that write.
3. **Secret-less clients are unaffected** — they connect with no
   `Authorization` header exactly as before.
4. **Managed tokens survive** the migration untouched (ciphertext rows are not
   modified); nothing else changes for them.
5. **`LXK_MCP_MASTER_KEY` is preserved across re-runs** like `GITHUB_*`, so
   upgrades do not clobber the key.

## Upgrading across the agent-runtime removal (2026-09-26)

The coding-agent ("agent-runtime") tier was deleted end to end — migration
`0008_remove_agent_runtimes.sql` drops `machines`, `runtimes`,
`runtime_events`, `runtime_sessions`, `runtime_task_logs`, renames
`runtime_tasks` → `assistant_tasks`, and drops the daemon token. The only AI
tier left is the in-process Assistant. See `docs/ARCHITECTURE.md` §Assistant →
removal record.

1. **Upgrade the server.** Boot applies `0008` (Bun standalone: re-run
   `install.sh` from the new release tag; Workers:
   `wrangler d1 migrations apply`). **Back up first** (`docs/BACKUPS.md`) —
   this is a hard drop of operational state.
2. **Stop and remove the machine listener on every host.** It has no server
   endpoint any more and will only log errors:
   ```bash
   systemctl --user disable --now lexa-machine-listener.service
   rm -rf ~/.local/share/lexa-runtimes ~/.lexa
   ```
   (Adjust the systemctl scope/root if you installed the unit system-wide.)
3. **No runtime reinstall exists.** `lx machine …` is gone; there is no
   `lx machine install` step, and the web UI has no "Setup runtime" flow.
4. **Daemon env keys are inert.** `RUNTIME_*` (and the older `HEARTH_*`) keys
   in host env files and per-runtime env files are no longer read by anything.
   Delete them; no error appears if you leave them.
5. **Preserved:** assistant chat threads, `assistant_tasks` history, memory,
   provider registry and keys, project settings, call logs, prices, provider
   health, agents/skills catalog (slimmed to the builtin `assistant` agent).
6. **Browsers need nothing** — session cookies, logins, and the web app are
   unaffected; no rebuild, no re-login.

## Upgrading across the Forge→Hearth rename (2026-08-24)

> Pre-release history: migrations `0001`–`0024` were squashed into a single
> `0001_init.sql` baseline for 2026.1.0 (no tagged release predates it, so no
> live database carries the old files). The rename below describes what the
> baseline already contains; fresh installs get it directly.

The baseline carries the renamed DB tables and activity types (`hearth_*`);
the server image applies it at boot. This rename is history only — the
listener/daemon it described was removed in 2026-09-26 (see above); no
`lx machine` command exists to reinstall.

## Upgrading across the Hearth→Runtimes rename (2026-09-24)

History only — superseded by the removal above. Hard cutover via migration
`0005_runtime_rename.sql`, applied at boot with no aliases for the old routes,
env keys, or header. Data was migrated, never dropped. The `HEARTH_*` →
`RUNTIME_*` env renames it required are now moot: those keys are inert.

## Upgrading across the Herald→Assistant rename (2026-09-24)

Hard cutover, migration `0006_assistant_rename.sql`: the server applies it at
boot, renaming the `herald_*` tables/indexes, rebuilding `assistant_settings` and
`via_herald` columns, remapping `engine`/`kind`/`source` values, and rebinding
builtin agent id `herald`→`assistant`, with no aliases for old routes, codes, or
JSON fields. Data is migrated, never dropped. No env keys or CLI changes;
this rename is server-side only.

1. **Upgrade the server.** Boot applies `0006_assistant_rename.sql` (Bun standalone:
   re-run `install.sh` from the new release tag; Workers: `wrangler d1 migrations apply`).
2. **Old API clients get 404** on `/api/herald/*` and `/api/admin/herald/*`. Error
   codes are now `ASSISTANT_*`; activity/comment JSON field `viaHerald` is now
   `viaAssistant`.
3. **Browsers:** reload for the new bundle; session cookies and logins are
   unaffected, with no rebuild or re-login.
4. **Preserved:** chat threads, memory, provider registry and keys, project settings,
   call logs, prices, and provider health.
5. **Nothing to reinstall** — the agent-runtime tier was already gone by this
   date's end state (2026-09-26); nothing machine- or daemon-related is part of
   this rename.
