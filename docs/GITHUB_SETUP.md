# GitHub Sync — Setup Guide

Two-way issue sync between Lexa boards and GitHub issues, via a GitHub App +
webhooks. Lexa→GitHub: moving a task to a column mapped `github_state: closed`
closes its linked issue (and vice-versa for `open`). GitHub→Lexa: closing /
reopening / editing an issue moves (or renames) the linked task — echo
suppression and delivery dedup make the loop safe.

## 1. Create the GitHub App (one-time, GitHub web UI)

1. GitHub → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Fill in:
   - **GitHub App name**: `lexa-<instance>`
   - **Homepage URL**: any URL, e.g. `https://<your-host>`
   - **Webhook URL**: `https://<host>/api/webhooks/github` — see §3 for which host
   - **Webhook secret**: click **Generate a secret** (or type one ≥ 16 chars,
      alphanumeric — the UI only accepts alphanumeric). **Save it** — it goes
      in Settings → GitHub Sync or `.env` / `.env.prod` as `GITHUB_WEBHOOK_SECRET`
3. **Repository permissions**:
   - **Issues**: `Read and write`
   - **Metadata**: `Read-only`
   - **Contents**: `Read-only` — enables the Forge repo-content context
     (the daemon gets the project's source-role repo files as grounding; see
     ARCHITECTURE.md → Forge repo-content). Optional: without it, Forge runs
     just don't receive repo files.
   **No permission changes needed for repo linking** — the same scopes cover
   linking, issue creation, content sync, and the autocomplete.
4. **Subscribe to events**: **Issues** only
5. **Create GitHub App**

## 2. Private key + install

1. On the app page → **Private keys** → **Generate a private key** → downloads
   `lexa-github-app.<date>.private-key.pem` (PKCS#1 format — handled internally)
2. **Install** the app → pick your account → **Only select repositories** → the
   repo(s) to sync (e.g. `owner/repo`) → **Install**

   **Install scope note:** **"All repositories" is recommended** — the
   Settings type-ahead (Linked Repos) and the task-detail issue autocomplete
   only see repos the App is INSTALLED on. "Only select repositories"
   silently limits both pickers, and every new repo link requires editing the
   install in GitHub.

## 3. Choose the webhook host

GitHub cannot reach `localhost`:

- **Prod/staging**: use the deployed host, e.g. `https://lexa.<domain>/api/webhooks/github`.
  The path must **bypass Cloudflare Access** (see §5) or GitHub gets 302s and deliveries fail.
- **Local dev**: run a quick tunnel and point the app's webhook URL at it:
  ```bash
  cloudflared tunnel --url http://localhost:3000   # → https://<random>.trycloudflare.com
  ```
  Webhook URL: `https://<random>.trycloudflare.com/api/webhooks/github`.
  The host changes every restart — update it in the app settings when you restart the tunnel.

## 4. Configure credentials

The **settings DB is the single source of truth at runtime**; env vars are a
first-boot bootstrap only (mirrored into the DB once at boot when the DB keys
are empty — the web UI then owns the config, live, no restart). Two ways to
provision:

### 4a. Configure via Settings (runtime truth)

**Settings → GitHub Sync** (admin): App ID (number, top of the app page),
upload the `.pem` private key, and the webhook secret from §1. Saves apply
**live** — no restart. Clearing a field (empty string) deletes the stored
value → not configured at runtime (an env value is re-imported only at the
next boot). The API never returns the key or secret (booleans only).

**Webhook URL**: `https://<host>/api/webhooks/github` (see §3 for which host).

### 4b. Configure env vars (bootstrap)

Env values are imported into the settings DB at boot **only when the DB key is
empty** — after that the DB wins and env is ignored until the key is cleared.

| Var | Meaning |
|-----|---------|
| `GITHUB_APP_ID` | App ID (number, top of the app page) |
| `GITHUB_PRIVATE_KEY` | Inline PEM with escaped newlines (`"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"`) |
| `GITHUB_PRIVATE_KEY_FILE` | Path to a `.pem` file, read at mirror time — **no escaping needed** (recommended; inline wins if both set) |
| `GITHUB_WEBHOOK_SECRET` | The secret from §1 (must match the App exactly) |

The `lexa-cli` operator tool defaults to the live server: `github status`
prints the server's effective settings and `github setup` pushes to the
Settings API (applied immediately, env untouched) — both require
`lexa-cli login`. The env-file path is explicit `--local`:
`github setup --local` writes the bootstrap values (imported at the next
boot only while the DB keys are unset) and `github status --local` validates
them. When not logged in, the remote default fails with a hint to log in or
use `--local` — there is no silent env fallback.

**Local dev** (`.env`):
```
GITHUB_APP_ID=1234567
GITHUB_PRIVATE_KEY_FILE=/home/you/projects/lexa/github-app.private-key.pem
GITHUB_WEBHOOK_SECRET=...
```

**Prod** (`.env.prod`): the PEM is volume-mounted read-only into the container
(`docker-compose.prod.yml` → `./github-app.private-key.pem:/app/github-app.private-key.pem:ro`),
so use:
```
GITHUB_APP_ID=1234567
GITHUB_PRIVATE_KEY_FILE=/app/github-app.private-key.pem
GITHUB_WEBHOOK_SECRET=...
```
`lexa-cli deploy <domain> prod` preserves the `GITHUB_*` block when it rewrites
the env file. The key file is gitignored (`*.private-key.pem`) and excluded
from the Docker build context (`.dockerignore`) — never commit it.

## 5. Cloudflare Access bypass (prod/staging)

The webhook, MCP, and REST API routes cannot do Access's browser flow.
`lexa-cli deploy` (v0.1.7+) provisions these automatically as self-hosted
Access apps with a **Bypass** (Everyone) policy:

- `<host>/api/webhooks/*` — GitHub deliveries
- `<host>/mcp` — agent clients
- `<host>/api/*` — `lexa-cli` / operator REST access (API key is the machine auth)

Access evaluates the most specific path first, so the UI
(`<host>/` on the main `Lexa (<flavor>)` app) stays session-gated.

For deployments created before v0.1.7, add them manually: Zero Trust →
**Access → Applications**, add one self-hosted application per path above
with a **Bypass** policy (include: Everyone).

Without the webhook bypass, GitHub deliveries get a 302 and fail. Verify
from outside: `POST <host>/api/webhooks/github` with a bad signature must
return **401** (from Lexa), not 302 (from Access).

## 6. Map columns

In the board's column settings, set a column to `github_state: open` (e.g.
Todo) and one to `closed` (e.g. Done). Mapping is by explicit state — column
renames can never break sync.

## 7. Acceptance round-trip

1. Link the project's repo first: Settings → GitHub Sync → **Linked Repos** → pick the project → add the repo (type-ahead) with **Issue workspace** checked. Create a task → Task detail → **GitHub Issues** → pick the repo in the dropdown → **+ New issue** → confirm. The card shows `repo #N` with a Synced dot.
2. Move the task to the closed-mapped column → the issue closes on GitHub
   within seconds. The resulting webhook is an **echo** (we pushed that state) —
   the task does not move again.
3. Close the issue on GitHub → the task moves to the closed column.
   Reopen → it moves back.
4. Bad-signature POST → 401:
   ```bash
   curl -i -X POST -H "X-Hub-Signature-256: sha256=deadbeef" \
     -H "Content-Type: application/json" -d '{}' <host>/api/webhooks/github
   ```

## Troubleshooting

- **Link fails with `GITHUB_API_ERROR: GitHub App is not configured`** — no
  credentials reach the server: set them in Settings → GitHub Sync (applies
  immediately) or check the env vars (container env / restart after editing
  `.env`).
- **Webhook deliveries never arrive** — check the app's delivery log
  (App settings → **Advanced**): `failed to connect to host` = wrong webhook
  URL; `302` = Access bypass missing; `401` = secret mismatch.
- **Closing an already-closed issue sends no webhook** — GitHub doesn't
  deliver no-op state changes. Reopen first to re-trigger.
- **A task that was moved while the issue was closed looks "Diverged"** —
  expected: out-of-sync is surfaced, not auto-healed; re-move the task to resync.
