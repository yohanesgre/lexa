# Dashboard manual deploy — Cloudflare Workers (DRAFT-UNVERIFIED)

> **Status: draft from docs, not from clicks.** Every step below marked
> `[verify]` needs confirmation against the live dashboard during the
> staging spike (spec `status/design-deploy-dashboard.md` wave2 S).
> Do not treat menu labels as exact until verified.

Goal: Lexa on Workers with **only a browser** — no bun, no wrangler,
no token, no secrets to invent. You download one release file and click.

Prereqs: a Cloudflare account (Workers Paid, $5/mo — free D1 caps at
500MB) and the workers tarball from a release:
`lexa-workers-vYYYY.MINOR.MICRO.tar.gz` (+ `checksums.txt`).

## Steps

1. `[verify]` Download + verify: fetch the tarball, check sha256 against
   `checksums.txt`, unpack. You need `dist/server/index.js`,
   `dist/server/wrangler.json`, `dist/client/`, `migrations/*.sql`.
2. `[verify]` Dashboard → Storage & Databases → **D1** → Create database
   named `lexa-prod` (staging: `lexa-staging`). Note the database ID.
3. `[verify]` Dashboard → **R2** → Create bucket `lexa-blobs-prod`
   (staging: `lexa-blobs-staging`).
4. `[verify]` Dashboard → Storage & Databases → **KV** → Create namespace
   titled `lexa-prod` (staging: `lexa-staging`). Note the namespace ID.
5. `[verify]` Workers & Pages → Create Worker → name it `lexa`
   (staging: `lexa-staging`) → upload `dist/server/index.js` as the
   worker script and `dist/client/` as assets.
   **Open risk:** the dashboard editor is single-file oriented; if the
   assets upload has no slot, this path is blocked until the spike finds
   the real upload affordance (or falls back to one `wrangler deploy`).
6. `[verify]` Bindings for the Worker: D1 binding `DB` → database from
   step 2; R2 binding `BLOB` → bucket from step 3; KV binding `KV` → id
   from step 4. Names are frozen — the worker reads exactly
   `DB`/`BLOB`/`KV`.
7. `[verify]` Variables: `LXK_ENV=production` (staging: `staging`);
   `LXK_PUBLIC_URL=https://<your-domain>` when using a custom domain.
   No secrets needed.
8. `[verify]` Cron trigger `*/15 * * * *` (prune + backup retention).
   Observability: enabled.
9. Apply migrations in order via the D1 console, then record them:
   run `migrations/0001_init.sql`, then `0002_device_login.sql`, then
   `INSERT INTO _migrations (name) VALUES ('0001_init.sql'), ('0002_device_login.sql');`
   **Open risk:** if the console path proves unworkable, migrations move
   into a `/setup` self-migrate (spike decision, not yet built).
10. `[verify]` Deploy → open `<worker>.workers.dev/api/health` → `{"ok":true}`.
11. Open `<worker>.workers.dev/setup` → create the superadmin.
    The first superadmin locks setup.
12. Login → Settings → API Keys → mint the first machine key
    (or `lexa-cli login --url <worker-url>` device flow).
13. Custom domain (optional): Workers & Pages → worker → Settings →
    Domains & Routes → add route `<domain>/*` (zone must be on this
    account). Workers.dev needs nothing.
14. **REQUIRED tail:** nothing auto-updates on this path — keep it that
    way. Re-deploy = repeat steps 5+9 (upload new bundle, apply only new
    migration files, append their `_migrations` rows).
15. One DB, one method: a database migrated here (`_migrations` journal
    via console) must not later be migrated by `install.sh workers`
    query runs or vice versa beyond the shared ordered files — and never
    mix with Button deploys (wrangler `d1_migrations` journal).

## Spike checklist (staging)

- [ ] Steps 5 and 9 confirmed clickable with exact labels recorded.
- [ ] `/api/health` 200, `/api/projects` 401 without key.
- [ ] `/setup` creates admin; second admin attempt 403.
- [ ] Post-login key mint works; Bearer calls succeed.
- [ ] This file's DRAFT banner removed and `[verify]` tags resolved.
