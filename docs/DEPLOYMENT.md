# Deployment & Environment Contract

This doc is the single source of truth for deploying Lexa and configuring its
environment. Deployment goes through **`scripts/install.sh`** — one script, one
target (`workers`, the default), zero clone: it installs into a self-describing
`cf-workers/` dir in the current directory. Staging is the exception: a second
Workers environment runs from a clone with plain `wrangler` (see §Staging from a
clone). The first superadmin is provisioned **only** by the web `/setup` wizard
(email + password ≥8) — the script never handles passwords.

> Removed in cli-v2026.2.0: `lexa-cli deploy` / `lexa-cli undeploy` /
> `--runtime workers` — hard-remove, no stubs. The install script replaced
> them; `lexa-cli` is now an operate-only headless frontend (tasks, wiki,
> machines, keys, upgrades).

## Deploy target

Cloudflare Workers (D1 + R2 + KV) is the deploy target. The installer ships the
prebuilt Worker bundle; there is no VPS process or tunnel. The **AI Assistant**
runs in-process on both flavors over SSE (ADR-0005; the ADR-0003
`@cloudflare/ai-chat` Durable Object tier is retired). See
`docs/RELEASING.md` for the release policy.

The canonical config file is **`.env.toml`**. It is structured TOML where the
sections (`[core]`, `[auth]`, `[github]`, …) are presentation only and every
leaf key is the env-var name verbatim (`DATABASE_PATH`, `LXK_*`).
Working env files are **never committed** — values are generated
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

> **Installer (shipped):** on the `workers` target the installer writes
> `cf-workers/.env.toml` (0600) as **custody** for the envelope key and pushes it
> to the Worker with `wrangler secret put`; it is not read by the deployed app,
> which takes its configuration from bindings and secrets. Re-runs **merge** —
> an operator-added `LXK_SECRETS_MASTER_KEY` is preserved, never rotated.

## Target

```bash
curl -fsSL https://install.yohanesgre.com/lexa/install.sh | bash -s -- workers [flags]
```

`workers` is the default. The installer hub serves the newest release with its
`BASE_URL` pinned to that release's tag. Pin explicitly with
`?ref=vYYYY.MINOR.MICRO`, or bypass the hub with the raw
`https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/install.sh`
URL for a tag.

| Target | Needs | Layout |
|---|---|---|
| `workers` | curl, tar, bun, `sha256sum` (or `shasum`), Cloudflare credentials | `cf-workers/` in the CWD: D1 database + R2 bucket + KV namespace provisioned, migrations applied, prebuilt Worker bundle deployed (`scripts/workers-install.ts`); the envelope key is kept in `cf-workers/.env.toml` custody |

Prerequisites are checked **before any download or mutation**: one pass collects
every missing tool and exits with a single list (tool → exact fix command).
Nothing is auto-installed. (The `dev` target is gone — development starts from a
clone.)

**Development** starts from a clone — `git clone
https://github.com/yohanesgre/lexa && cd lexa`, then `bun install && bun run
setup && bun run dev`.

Flags: `--ref <tag>` (artifact source: a release tag), `--name <name>` (workers
deploy name, default `lexa`), `--account <id>` (Cloudflare account id; skips the
account prompt and disambiguates a multi-account token), `--cf-token <token>`
(Cloudflare API token; see the credentials chain below), `--domain <domain>`
(workers custom domain; skips the prompt), `--secrets-file <path>` (optional
secrets applied at install; see below), `--reset-db` (drop the existing D1
database and start migrations fresh — data is lost), `--from-repo <dir>`
(install from a local checkout), `--yes`.

### Cloudflare Workers target

- **Custom domain:** interactive runs always offer the prompt (Enter =
  free `lexa.<account>.workers.dev` subdomain); `--domain lexa.example.com`
  skips it (zone-validated at provision time).
- **Cloudflare credentials:** `--cf-token` flag, then `CF_API_TOKEN`, then the
  saved `cf-workers/.cf-token`, then an existing `wrangler login` (silent read;
  verified once before use), then a hidden TTY prompt. A token read from
  `wrangler login` needs no pasting. Provisioning is find-or-create — re-runs
  reuse the existing D1/R2/KV resources and apply migrations incrementally.
  D1 is matched by exact deploy name, otherwise by a single `${name}-`-prefixed
  database (deploy `lexa` reuses a lone `lexa-prod`); several matches refuse the
  run rather than guess — remove the stale database, or pass `--name <deploy>`
  to start a distinct deployment under that name.
- **Account selection:** with several accounts on the token the installer picks
  on a TTY, refuses headless listing the account ids, honors `--account` /
  `CLOUDFLARE_ACCOUNT_ID`, and refuses a stale explicit id with guidance. A
  re-run reuses the account recorded by the previous deploy's wrangler config.
- **Envelope key (custody):** the installer mints `LXK_SECRETS_MASTER_KEY` once
  and keeps it in `cf-workers/.env.toml` (0600). On re-runs the order is local
  custody → remote presence (`wrangler secret list`) → mint, so the key is
  **never rotated**. A presence check that cannot run reports `unknown` and
  mints nothing — if the key can't be read, nothing is minted and the existing
  one is left untouched. It is pushed with `wrangler secret put` reading from a
  0600 file on stdin — never argv, never stdout.
- No tunnel, no VPS: the Worker route (custom domain or workers.dev) is the
  public entry. See `docs/CLOUDFLARE_WORKERS.md` for runtime details.
- **Zero-file alternative (DRAFT-UNVERIFIED):** Deploy Button (one click,
  no CLI — see below) or manual dashboard clicks
  (`docs/DEPLOYMENT_DASHBOARD.md`). Same bindings, same migrations,
  no secrets to paste — machine keys are minted post-setup.

### Staging from a clone (no install.sh)

A second, isolated Workers environment deploys straight from a repo checkout —
no release tarball, no `install.sh`. Use it to rehearse migrations and let a
branch soak before production; every resource is named after the deploy name,
so nothing touches the prod worker, database, or bucket.

Shortcut: `bun run deploy:staging` runs the keep-data flow (build, migrate,
deploy, push the key) and `bun run deploy:staging:reset` wipes the worker +
D1/KV/R2, recreates them, updates the config ids, and redeploys — both wrap
`scripts/deploy-staging.sh`. The manual steps below remain the reference.

```bash
git clone https://github.com/yohanesgre/lexa && cd lexa
bun install
bun x wrangler d1 create lexa-staging
bun x wrangler r2 bucket create lexa-staging-blobs
bun x wrangler kv namespace create lexa-staging
cp wrangler.staging.example.jsonc wrangler.staging.local.jsonc  # fill in the ids + the public URL
bun run build:workers
bun x wrangler d1 migrations apply DB --remote --config wrangler.staging.local.jsonc
bun x wrangler deploy --config wrangler.staging.local.jsonc
bun x wrangler secret put LXK_SECRETS_MASTER_KEY --config wrangler.staging.local.jsonc
```

- `wrangler.staging.example.jsonc` (repo root) mirrors the config
  `workers-install.ts` generates: worker `lexa-staging`, D1 `lexa-staging`, R2
  `lexa-staging-blobs`, KV, `main`/`assets` from the built `dist/`, `no_bundle`
  plus the ESModule rule, and the observability block from the root
  `wrangler.jsonc`. (ADR-0005 W6 removed the assistant Durable Object + its
  self service binding, the `ai` binding, and the `*/15` cron from the config.)
  Fill `<ACCOUNT_ID>` (multi-account tokens only),
  `<D1_DATABASE_ID>`, `<KV_NAMESPACE_ID>`, and `<PUBLIC_URL>` in the copied
  file.
- `LXK_SECRETS_MASTER_KEY` is **required** — Better Auth's session-signing
  secret derives from it (see the variable table) — mint it as base64 of exactly
  32 bytes (`openssl rand -base64 32`). Configure GitHub sync in the web app
  after first deploy — point staging at its own GitHub App (one webhook URL
  belongs to one App).
- `LXK_PUBLIC_URL` is **required** for browser sign-in — set it to the deployed
  URL (workers.dev or custom domain). Unset, it falls back to
  `http://localhost:5173` for the Better Auth baseURL + trustedOrigins and
  Better Auth rejects the real origin with `Invalid origin`. A custom domain
  needs a zone in the same Cloudflare account.
- First superadmin: open `<url>/setup`.
- Updating staging: check out the branch or commit, `bun run build:workers`,
  and re-run the migrate + deploy commands with the same config. Resources,
  data, and secrets persist.

Rules:

- Never deploy staging with the root `wrangler.jsonc` — it names the prod
  worker and prod resources. Never run `bun run db:migrations:apply` or
  `bun run deploy:workers` for staging; both ignore the staging config.
- One method per database: this path writes wrangler's `d1_migrations` journal.
  A database migrated by `install.sh workers` (`_migrations`) must keep using
  that method, and vice versa — mixing the two double-applies migrations.
- The filled `wrangler.staging.local.jsonc` carries account and resource ids —
  gitignored, never committed.
- `wrangler … create` auto-appends the new resource to the wrangler config in
  the current directory; if that is the root `wrangler.jsonc`, remove the
  appended blocks before building (a duplicate binding name fails the build).
  `deploy-staging.sh --reset` snapshots and restores the config around its
  creates.

`install.sh workers --name lexa-staging` remains the tarball-based route to the
same isolation (`--name` keys the resource names).

### Optional secrets at install

`--secrets-file <path>` applies `KEY=value` lines (keys validated against the
installer whitelist) at install time. `workers` pushes only the master key
(resolved from custody / remote / mint) with `wrangler secret put` and writes
the file's other keys to `cf-workers/.env.toml` custody. GitHub keys are
rejected here — configure GitHub sync in the web app after install. Reconfigure
later with the same flag, or edit the custody file and re-run.

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
curl -fsSL https://raw.githubusercontent.com/yohanesgre/lexa/<tag>/scripts/uninstall.sh | bash -s -- workers
```

The Worker is deleted; D1/R2/KV data is always **kept** (delete those resources
from the Cloudflare dashboard to remove data). `--purge` (requires typing
`purge` on a TTY) also removes the saved local `.cf-token`. The CLI itself is
uninstalled manually (`rm $(which lx)`). Pass `WORK_DIR` when the target dir is
not `cf-workers/`.

## Upgrade

**Re-run `install.sh` from the new release tag — that is the whole upgrade.**
The script is idempotent: it reuses the Cloudflare resources and applies only
new D1 migrations. Env writes merge, so
operator-added keys are preserved and a previous install upgrades cleanly.

Workers upgrades resume the previous deploy: run from the same directory
(`cf-workers/`), and the domain defaults to the last one (Enter keeps it); the
credentials are reused from `--cf-token`, `CF_API_TOKEN`, the saved
`cf-workers/.cf-token` file, or an existing `wrangler login` (offered for saving
after TTY entry, `chmod 600`, never written from env/flag values), and
`LXK_SECRETS_MASTER_KEY` is read back from `cf-workers/.env.toml` custody so it
is never rotated. Starting in a directory with no previous deploy asks for
confirmation first. On a shared machine, decline the token-save offer.

For an in-place update of an existing custody dir from the headless CLI
(`lx worker upgrade`), see
[`docs/CLOUDFLARE_WORKERS.md`](CLOUDFLARE_WORKERS.md#upgrading-a-workers-deployment-lx-worker-upgrade)
§Upgrading a Workers deployment.

**Upgrading from a DO-era deployment (ADR-0005).** The assistant Durable Object
(`LexaAssistantAgent`) is retired and no longer exported by the script. A
deployment that already owns the class must carry the frozen delete-class
migration or the deploy fails with CF error 10064 ("New version of script does
not export class 'LexaAssistantAgent' which is depended on by existing Durable
Objects"). The repo `wrangler.jsonc` and `lx worker upgrade` already append it;
a hand-managed config (e.g. a filled `wrangler.staging.local.jsonc`) must add:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["LexaAssistantAgent"] },
  { "tag": "v2", "deleted_classes": ["LexaAssistantAgent"] }
]
```

A fresh install never carries this history — the installer and `lx worker
upgrade` emit no `migrations` for a config that never owned the DO.

## Sample data

Sample data is offered in every environment: the web wizard shows the
sample-data step on local installs, `/api/setup/seed` has no environment
gate, and `bun run setup` offers it interactively. The Backlog swimlane and
default columns appear when the first project is created.

## Who writes what

`bun run setup` (via `server/env-file.ts`) writes `.env.toml` at 0600, merging
into any existing file. The loader applies `.env.toml` (or a legacy `.env`) at
boot and never overwrites a variable already set in the real environment.
`LXK_SECRETS_MASTER_KEY` is preserved across re-runs.

| Variable | Written by | Required |
|---|---|---|
| `API keys (lxk_...)` | minted post-setup via login session (Settings → API Keys, or `lx login` device flow) | only for non-browser clients (CLI/scripts) |
| `LXK_ENV` | install script / setup wizard | yes (`production` on deployed targets) |
| `LXK_PUBLIC_URL` | install script (stamped on every deploy — custom domain, else the resolved workers.dev host) | deployed targets (Better Auth baseURL + trustedOrigins) |
| `CF_API_TOKEN` | operator env (workers target only) | workers only |
| `LXK_ADMIN_EMAILS` | setup wizard (dev bootstrap) | dev only |
| `LXK_ASSISTANT_REPO_CAP` | hand-set (only to override the default repo-content cap) | no — assistant-only (Workers) |
| `LXK_TRUSTED_PROXY_CIDRS` | hand-set (Bun/dev only — inert on Workers, which trusts the edge's `cf-connecting-ip`; set only when a non-loopback proxy fronts the API) | no |
| `LXK_MAX_BODY_MB` / `LOG_LEVEL` / `DATABASE_PATH` / `PORT` | defaults; tune by hand | no |
| `LXK_SECRETS_MASTER_KEY` | minted by the installer and pushed/custodied in `cf-workers/.env.toml`; preserved across install-script re-runs | **required** — the server fails closed without it (Better Auth's session-signing secret derives from it); it also gates managed-secret storage (MCP token, provider key, Jev API key) and the assistant's internal HMAC derivation |

## Full variable reference

| Variable | Meaning |
|---|---|
| `DATABASE_PATH` | SQLite file path for the Bun local-dev flavor (default `./data/lexa.db`); not read on Workers (D1 binding) |
| `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_FILE` / `GITHUB_WEBHOOK_SECRET` | REMOVED — configure GitHub sync in the web app (Settings → GitHub Sync); legacy values are warned and ignored |
| `LOG_LEVEL` | logging level (default `info`) |
| `LXK_ADMIN_EMAILS` | comma-separated **superadmin** emails — env-only allow-list, applied at provisioning (dev setup wizard only); never edited at runtime |
| `LXK_API_KEY` | REMOVED — no longer provisioned or read. Pre-change installs keep their DB-seeded row; fresh installs mint user-bound keys post-setup. Workers installs auto-prune the leftover Worker secret after a successful deploy (manual fallback: `wrangler secret delete LXK_API_KEY --name lexa --config deploy-lexa/wrangler.lexa.json`). |
| `LXK_ASSISTANT_REPO_CAP` | cap on source-role repos used as assistant grounding context (default 3) |
| `LXK_RUNTIME_DAEMON_TOKEN` | REMOVED (agent-runtime tier deleted, migration `0008`) — no longer read; leaving it set is harmless, remove it at your convenience |
| `LXK_MAX_BODY_MB` | max request body for `/api` in MB (default 16); webhook payloads hard-capped at 1 MB before HMAC, regardless |
| `LXK_SECRETS_MASTER_KEY` | **required** — the server fails closed without it: Better Auth's session-signing secret is derived from it (`lexa-better-auth:<key>`), so a missing key throws at auth construction with a `bun run setup` hint. It is also **required to store a managed secret** — an MCP client token, an LLM provider API key, or the Jev API key. The master key lives only in the server environment. Base64 of **exactly 32 bytes** (base64url is accepted too; `openssl rand -base64 32`). Set it in the server environment, never in the database, never in a response or a log, and never commit it. Rotating: set `LXK_SECRETS_MASTER_KEY_PREV` to the **old** value, `LXK_SECRETS_MASTER_KEY` to the **new** one, restart — managed-secret rows stay readable through the PREV slot (no outage, no rewrap step), but **all sessions are invalidated** (the session-signing secret derives from the active key, so users sign in again). Remove PREV once every row is re-entered. |
| `LXK_SECRETS_MASTER_KEY_PREV` | **optional, read-only** — the previous `LXK_SECRETS_MASTER_KEY`, same 32-byte base64 shape. It is the rotation *read* path only: rows encrypted under the old slot (`key_id = 'prev'`) keep resolving, and any secret entered while it is set is encrypted under the **active** key. Remove it once every row is re-entered (an unfinished rotation is a warning, not a break). |
| `LXK_PUBLIC_URL` | public base URL of this install (e.g. `https://lexa.example.com`) — Better Auth `baseURL` + `trustedOrigins`; written by the install script; hand-set in dev |
| `LXK_SEED_DEV` | dev-only boot-time sample data (`1` enables; set by `scripts/dev.sh`) |
| `LXK_TRUSTED_PROXY_CIDRS` | **Bun/dev-only — inert on Workers**, which has no socket peer and trusts the edge's `cf-connecting-ip` as-is. Comma-separated IPv4/IPv6 CIDRs or bare IPs of reverse proxies allowed to contribute a trusted `cf-connecting-ip` header to rate limiting. **Unset/empty → loopback only** (`127.0.0.0/8`, `::1`, and the v4-mapped form) — correct when a reverse proxy connects from this host. Set it when the proxy is a separate host reachable over a private network (e.g. `172.16.0.0/12`, `10.0.0.0/8`). A peer that is neither loopback nor listed here has its forwarding header **ignored** (the socket/stamped IP is used), so a direct client cannot spoof its way into a fresh bucket. Malformed entries are ignored; the key is never a boot failure. |
| `PORT` | server port (default 3000) |

**Jev is configured in the webapp** (Admin → Assistant → Providers & Models),
not via env — the API key is stored encrypted like a provider key and the layer
can be toggled + tested there. No Jev env variables exist.

**Unused by the server:** `LXK_ACCESS_AUD` / `LXK_ACCESS_TEAM` (Cloudflare
Access) — the server reads them nowhere. Browsers authenticate via the
session cookie.
**Never exist:** Google OAuth envs, SMTP envs — human auth is in-app
email/password (Better Auth).

## Bootstrap

**Local dev:** `bun run setup` (dev-only CLI wizard: admin email, API key,
migrations, optional sample data — self-hosters use the install script +
`/setup` wizard instead) then `bun run dev` (Bun: API :3000 + vite :5173,
vite proxies `/api`). `dev` sets `LXK_SEED_DEV=1` for boot-time sample data.
`bun run dev:workers` is the local Worker flavor (vite + workerd :5173).
Dev also sets `LXK_PUBLIC_URL=http://localhost:5173` (the Better Auth
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
  script content cannot change between your read and your run. Release
  tarballs are additionally sha256-verified by the script.
- `.env.toml` (and any legacy `.env*`) is gitignored — values are generated on
  the machine, never committed. Re-running the install script **merges** into
  the custody file (`cf-workers/.env.toml`): installer-owned keys are
  rewritten, operator-added keys (`LXK_SECRETS_MASTER_KEY`, …) are preserved.
  DB-minted API keys survive in D1.
- The GitHub App private key is stored encrypted in the DB via the web app
  (Settings → GitHub Sync) — never written in plaintext to an env file or any
  operator-managed file.
- `/api/*` accepts a session cookie OR a Bearer key (dual-channel);
  `/api/webhooks/*` is HMAC-only. Keys are `lxk_` + 43 base62 chars
  (256-bit), rate-limited per IP, revocable per-named-key (Settings → API
  Keys). Failed logins on `/api/auth/*` are throttled in-process (Better Auth
  rate-limit plugin; ~5 attempts/60s per email, 15 min lockout).
- Managed secrets (MCP client tokens, LLM provider API keys, and the Jev API
  key) are third-party credentials held the same way as the GitHub key: the
  plaintext is entered once in the webapp, stored AES-256-GCM encrypted in the
  DB, and never returned by the API. The Jev client logs nothing itself and
  returns only a typed outcome — a request's state text and the key are absent
  from every failure message, and the stderr log line carries only `mode`,
  `outcome`, `code`, `latencyMs`, and returned `usage` — never state text.
- `LXK_SECRETS_MASTER_KEY` (and its read-only `LXK_SECRETS_MASTER_KEY_PREV`) is
  the envelope key for every managed secret — MCP tokens, provider API keys, and
  the Jev API key — and the source of Better Auth's session-signing secret, so
  it is **required** (the server fails closed without it). It is set by
  hand in the server environment (or
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
   (`LXK_API_KEY`, `VITE_LXK_API_KEY`, `RUNTIME_*`, `LXK_ACCESS_*`,
   `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_PRIVATE_KEY_FILE`,
   `GITHUB_WEBHOOK_SECRET`) are dropped rather than carried.
2. **Rollback** — nothing is destructive: restore the legacy file and remove the
   new one.
   ```bash
   rm .env.toml && mv .env.legacy .env
   ```
3. **Workers install: just re-run the installer.** It writes/merges
   `cf-workers/.env.toml` custody — the resolved master key is preserved
   verbatim, and any `--secrets-file` keys are merged in. No manual conversion
   is needed.
4. **Permissions** — the custody file `cf-workers/.env.toml` is written 0600
   and stays gitignored (`.env.toml.example` is the only tracked env file).

## Upgrading across the secrets rename + provider/Jev secrets (2026-09-29)

This release hard-renames the envelope key and moves provider keys and Jev
configuration into the encrypted, webapp-managed store.

1. **Rename the env var to the same value.** `LXK_MCP_MASTER_KEY` becomes
   `LXK_SECRETS_MASTER_KEY` (and `LXK_SECRETS_MASTER_KEY_PREV` likewise) — a
   plain rename, **same value, no aliases**. Stored ciphertext is unaffected: the
   keyring, the AAD layout, and the `active`/`prev` slots are unchanged, so
   existing MCP tokens keep decrypting. Set it before the first boot of the new
   build (on Workers: `wrangler secret put LXK_SECRETS_MASTER_KEY`).
2. **Jev env keys are gone; configure Jev in the webapp.** The three
   `TYPESAFE_*` variables are deleted. Open Admin → Assistant → Providers &
   Models, set the base URL + model, enter the API key, test it, and enable the
   layer; per-project opt-in is on each project's Assistant card. Until then Jev
   is simply disabled and the assistant behaves exactly as before.
3. **Provider keys backfill once, at boot.** With the renamed key present, the
   first boot of this release encrypts every non-empty
   `assistant_providers.api_key` into `assistant_provider_secrets` and writes the
   legacy column to `''`. It is idempotent (Bun: once at server start; Workers:
   the per-isolate first request). **Blocked without a key:** if the master key
   is unset, nothing is written and a boot log names the count — providers that
   still hold a legacy plaintext key then fail calls with 502
   `PROVIDER_AUTH_FAILED` until the key is set and the server restarts. Never
   blank the column by hand.
4. **Gate before the next release.** The dead column is dropped forward-only in
   Release N+1 (`0016_drop_provider_api_key.sql`). Before upgrading to it, set
   `LXK_SECRETS_MASTER_KEY`, boot this release at least once on every database
   (Bun restart; Workers deploy + one request), and verify the backfill is
   complete on each:
   ```sql
   SELECT COUNT(*) FROM assistant_providers WHERE api_key <> '';
   ```
   `0` on every DB means the drop is safe; the guard aborts otherwise.
5. **Forward-only.** After `0016` an older build cannot run (it writes the
   dropped column); downgrading means restoring a pre-upgrade backup
   (`docs/BACKUPS.md`).

## Upgrading across the assistant move to Workers (2026-10-02) — historical

> **Superseded by ADR-0005 (W6, 2026-10-10).** The assistant returned to the
> **in-process TanStack AI SSE tier on both flavors**; the `@cloudflare/ai-chat`
> Durable Object executor, its internal HMAC routes, and the DO binding are
> retired. The notes below record the 2026-10-02 move; the "Bun flavor loses the
> assistant" and "deploys the DO class" steps no longer apply — the assistant is
> mounted on both flavors again and there is no DO to deploy.

The AI Assistant became **Cloudflare Workers only** (ADR-0003): it ran on
`@cloudflare/ai-chat` Durable Objects and was absent from the Bun local-dev
flavor, which served no assistant routes.

1. **The Bun local-dev flavor loses the assistant.** `/api/assistant/*` and
   `/api/admin/assistant/*` return **404** (the groups are not mounted), the
   assistant UI is hidden, and `GET /api/capabilities` reports
   `{ "assistant": false, "flavor": "bun" }`. Everything else keeps working.
2. **There is no cross-flavor data sync** (`docs/CLOUDFLARE_WORKERS.md`). The
   `assistant_*` tables are **not dropped** on the
   Bun flavor (they remain inert, so a downgrade/backup still has them), but
   nothing reads or writes them there.
3. **Workers requires `LXK_SECRETS_MASTER_KEY`.** Better Auth's session
   signing secret derives from it (`lexa-better-auth:<key>`), so the server fails
   closed without it; provider secrets are decrypted from it. (The former
   assistant internal HMAC key derived from it was retired with the DO tier in
   ADR-0005 W6.) The installer mints and preserves this key in
   `cf-workers/.env.toml` custody (see the Upgrade section); no manual step is
   needed on a normal install.
4. **Workers upgrade is a normal re-run** of `install.sh` from the new release
   tag: it applies the D1 migrations (none required for the assistant move —
   the tables already exist) and deploys the bundle. (ADR-0005 W6: no DO class
   is deployed; D1 `assistant_threads` is the single assistant store.)
5. **Preserved on Workers:** chat threads, `assistant_tasks` history, memory,
   provider registry and keys, project settings, call logs, prices, provider
   health, and the agents/skills catalog.

### Verifying recovery + cost on a live Workers deploy (manual, deployer-run)

The local gate exercises the in-process SSE tier's reliability pins (partial
persist, resume claim, 409 guard, modes), but gateway rate limits and real cost
are only observable on a live deploy. Steps:

1. **Deploy, then start a turn and reload mid-turn.** While a long chat or
   document turn is streaming, reload the page (or drop the network). Expected:
   the turn is killed (accepted class — ADR-0005 §Reliability), the partial turn
   persists with `stopped: true`, `assistant_tasks.status` transitions exactly
   once, and no duplicate `task_activity` rows appear (invariant #12). In-app
   navigation keeps the run alive.
2. **Confirm cost/limits (R1).** Workers dashboard → AI Gateway (requests,
   tokens) and Workers requests/CPU. The in-process tier has no Durable Object
   billing surface. Compare against the plan's ~$5/mo + usage budget.
3. **Rate-limit UX (R2).** Drive a gated model through a tool loop until the
   gateway returns 20 rpm (50 with prepaid credits). Expected: a
   `PROVIDER_RATE_LIMITED` (429) frame plus the fallback-model walk, never a
   hung turn.
4. **Confirm metadata-only gateway logs (D7, R13).** After a turn, the gateway's
   logs show request metadata only, not prompt/response payloads. The app sends
   `cf-aig-collect-log-payload: false` on every provider request (ADR-0003 §C
   D7), which overrides the gateway's own payload-collection toggle — payloads
   can only be enabled by changing the app-sent header (the
   `RegistryModelConfig.collectLogPayload` switch, not wired from any production
   config path today), never from the dashboard toggle alone.

## Upgrading across managed-only MCP client secrets (2026-09-28)

MCP client credentials became managed-only: the `env:NAME` / `file:/abs/path`
reference source and its allowlist/denylist were removed, and
`LXK_SECRETS_MASTER_KEY` is now required to store a token (secret-less clients stay
legal). See `docs/ARCHITECTURE.md` §Managed-only MCP client secrets.

1. **Migration ordering matters.** Boot applies
   `0012_remove_mcp_secret_refs.sql`, which clears every stored `secret_ref`
   with a single value `UPDATE` (no DDL, no FK interaction; idempotent).
   Upgrade the build and run migrations together, or run
   `wrangler d1 migrations apply` before the new Worker starts (only for a
   wrangler-journal database; on an `install.sh`-managed one it mixes journals
   — see the one-method rule). An **old build
   on an un-migrated database** can still resolve a stored ref; the **new build
   refuses a stored ref** at connect (`MCP_CONNECT_FAILED`) until a write
   clears it — never an anonymous connect.
2. **Stored references stop authenticating.** Any client that used `env:` /
   `file:` must have a Bearer token **entered** in the webapp instead (Settings
   → Assistant → MCP Clients), which needs `LXK_SECRETS_MASTER_KEY` set. The token
   is stored encrypted and the legacy ref is cleared on that write.
3. **Secret-less clients are unaffected** — they connect with no
   `Authorization` header exactly as before.
4. **Managed tokens survive** the migration untouched (ciphertext rows are not
   modified); nothing else changes for them.
5. **`LXK_SECRETS_MASTER_KEY` is preserved across re-runs**, so upgrades do not
   clobber the key.

## Upgrading across the agent-runtime removal (2026-09-26)

The coding-agent ("agent-runtime") tier was deleted end to end — migration
`0008_remove_agent_runtimes.sql` drops `machines`, `runtimes`,
`runtime_events`, `runtime_sessions`, `runtime_task_logs`, renames
`runtime_tasks` → `assistant_tasks`, and drops the daemon token. The only AI
tier is the Workers-only Assistant (ADR-0003); the Bun flavor serves none. See
`docs/ARCHITECTURE.md` §Assistant → removal record.

1. **Upgrade the server.** `install.sh` from the new release tag applies `0008`.
   **Back up first** (`docs/BACKUPS.md`) — this is a hard drop of operational
   state. (`wrangler d1 migrations apply` is the fallback only for a
   wrangler-journal database; on an `install.sh`-managed one it writes a second
   `d1_migrations` journal and double-applies — see the one-method rule.)
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
migrations apply it. This rename is history only — the
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

1. **Upgrade the server.** `install.sh` from the new release tag applies
   `0006_assistant_rename.sql`. (`wrangler d1 migrations apply` is only for a
   wrangler-journal database; on an `install.sh`-managed one it mixes journals —
   see the one-method rule.)
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
