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
     alphanumeric — the UI only accepts alphanumeric). **Save it** — it goes in
     `.env` / `.env.prod` as `GITHUB_WEBHOOK_SECRET`
3. **Repository permissions**:
   - **Issues**: `Read and write`
   - **Metadata**: `Read-only`
4. **Subscribe to events**: **Issues** only
5. **Create GitHub App**

## 2. Private key + install

1. On the app page → **Private keys** → **Generate a private key** → downloads
   `lexa-github-app.<date>.private-key.pem` (PKCS#1 format — handled internally)
2. **Install** the app → pick your account → **Only select repositories** → the
   repo(s) to sync (e.g. `owner/repo`) → **Install**

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

## 4. Configure env vars

| Var | Meaning |
|-----|---------|
| `GITHUB_APP_ID` | App ID (number, top of the app page) |
| `GITHUB_PRIVATE_KEY` | Inline PEM with escaped newlines (`"-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"`) |
| `GITHUB_PRIVATE_KEY_FILE` | Path to a `.pem` file, read at boot — **no escaping needed** (recommended; inline wins if both set) |
| `GITHUB_WEBHOOK_SECRET` | The secret from §1 (must match the App exactly) |

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
`scripts/setup.sh <domain> prod` preserves the `GITHUB_*` block when it rewrites
the env file. The key file is gitignored (`*.private-key.pem`) and excluded
from the Docker build context (`.dockerignore`) — never commit it.

## 5. Cloudflare Access bypass (prod/staging)

The webhook and MCP routes cannot do Access's browser flow. In Zero Trust →
**Access → Applications**, add a second self-hosted application scoped to
`<host>/api/webhooks/*` with a **Bypass** policy (include: Everyone), and one
for `<host>/mcp`. Without the webhook bypass, GitHub deliveries get a 302 and
fail. Verify from outside: `POST <host>/api/webhooks/github` with a bad
signature must return **401** (from Lexa), not 302 (from Access).

## 6. Map columns

In the board's column settings, set a column to `github_state: open` (e.g.
Todo) and one to `closed` (e.g. Done). Mapping is by explicit state — column
renames can never break sync.

## 7. Acceptance round-trip

1. Create a task → Task detail → **GitHub Issues** → type `owner/repo` → **Create issue**.
   The card shows `repo #N` with a Synced dot.
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

- **Link fails with `GITHUB_API_ERROR: GitHub App is not configured`** — the
  env vars aren't reaching the server (check the container env / restart after
  editing `.env`).
- **Webhook deliveries never arrive** — check the app's delivery log
  (App settings → **Advanced**): `failed to connect to host` = wrong webhook
  URL; `302` = Access bypass missing; `401` = secret mismatch.
- **Closing an already-closed issue sends no webhook** — GitHub doesn't
  deliver no-op state changes. Reopen first to re-trigger.
- **A task that was moved while the issue was closed looks "Diverged"** —
  expected: out-of-sync is surfaced, not auto-healed; re-move the task to resync.
