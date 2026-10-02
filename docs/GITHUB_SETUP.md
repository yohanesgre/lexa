# GitHub Sync — Setup Guide

Two-way issue sync between Lexa boards and GitHub issues, via a GitHub App +
webhooks. Lexa→GitHub: moving a task to a column mapped `github_state: closed`
closes its linked issue (and vice-versa for `open`). GitHub→Lexa: closing /
reopening / editing an issue moves (or renames) the linked task — echo
suppression and delivery dedup make the loop safe.

## 1. Connect the GitHub App (in-app)

The supported path is the in-app **manifest connect flow**: Lexa creates the
GitHub App for you, so there is no manual App-creation form to fill in.

**Prerequisites (admin):**

- `LXK_PUBLIC_URL` set to this install's public origin (e.g.
  `https://lexa.example.com`). GitHub needs it for the webhook URL and the
  redirect back to Lexa — a `localhost` URL is not reachable from GitHub. For
  local dev, point it at a tunnel (see below).
- `LXK_SECRETS_MASTER_KEY` set (32 bytes, base64). The connect flow stores the
  App's PEM and webhook secret **encrypted**; without the key the setup is
  refused with `GITHUB_SECRET_WRITE_FAILED` (500) — it never falls back to
  plaintext.

**Steps:**

1. **Settings → GitHub Sync → Connect GitHub App.**
2. GitHub opens its **Create GitHub App** form pre-filled from Lexa's manifest
   (name `Lexa`, homepage + webhook URL from `LXK_PUBLIC_URL`, the permissions
   and event below). Confirm with **Create GitHub App**.
3. GitHub creates the App and redirects back to
   `/settings/github/callback`, which completes the handshake: Lexa exchanges
   the one-time code, verifies the App's permissions, and stores the
   credentials (App ID + slug plaintext; PEM + webhook secret encrypted in
   `github_app_secrets`). The config applies **live** — no restart.
4. **Install** the new App: on the App page → **Install App** → pick your
   account → **All repositories** (recommended; see the scope note) or **Only
   select repositories** → the repo(s) to sync (e.g. `owner/repo`) →
   **Install**.

The manifest sets:

- **Permissions** — Issues: `Read and write`; Metadata: `Read-only`;
  Contents: `Read-only` (enables the Assistant repo-content grounding; see
  ARCHITECTURE.md → Assistant repo-content). Nothing else.
- **Subscribed events** — `Issues` only.
- **Webhook URL** — `${LXK_PUBLIC_URL}/api/webhooks/github`; GitHub generates
  the webhook secret and hands it back during creation, so it never needs to
  be typed.

**Install scope note:** **"All repositories" is recommended** — the Settings
type-ahead (Linked Repos) and the task-detail issue autocomplete only see repos
the App is INSTALLED on. "Only select repositories" silently limits both
pickers, and every new repo link requires editing the install in GitHub.

**Account note (v1):** the manifest creates the App under the signed-in admin's
**personal account**. Org-owned App creation (GitHub's
`organizations/<org>/settings/apps/new` manifest flow) is a follow-up.

**Reconnect:** v1 has **no separate Reconnect control** — on an
already-configured install the same **Connect GitHub App** button starts the
flow again and **REPLACES** the current App. GitHub creates a brand-new App, so
the previous App's credentials — including its **webhook secret** — are
dropped: deliveries from the old App stop verifying. Install the new App and
use the new App's webhook. (Configuring the same App again by re-running the
flow does not preserve the old secret.)

### Webhook host

The webhook URL comes from `LXK_PUBLIC_URL`, so GitHub must be able to reach it:

- **Prod/staging**: the public origin, e.g.
  `https://lexa.<domain>/api/webhooks/github`. The route is key-exempt but
  HMAC-protected — no edge gate in the way; the webhook authenticates with the
  `X-Hub-Signature-256` header only.
- **Local dev**: run a quick tunnel and set `LXK_PUBLIC_URL` to it before
  connecting:
  ```bash
  cloudflared tunnel --url http://localhost:3000   # → https://<random>.trycloudflare.com
  ```
  The host changes every restart — reconnect (or edit the App's webhook URL in
  GitHub) when you restart the tunnel.

## 2. Map columns

In the board's column settings, set a column to `github_state: open` (e.g.
Todo) and one to `closed` (e.g. Done). Mapping is by explicit state — column
renames can never break sync.

## 3. Acceptance round-trip

1. Link the project's repo first: Settings → GitHub Sync → **Linked Repos** →
   pick the project → add the repo (type-ahead) with **Issue workspace**
   checked. Create a task → Task detail → **GitHub Issues** → pick the repo in
   the dropdown → **+ New issue** → confirm. The card shows `repo #N` with a
   Synced dot.
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

- **Connect fails with `GITHUB_SECRET_WRITE_FAILED` (500)** —
  `LXK_SECRETS_MASTER_KEY` is unset or malformed. Set a 32-byte base64 key on the
  server and reconnect (the connect flow never stores credentials as plaintext).
- **Connect fails with `GITHUB_MANIFEST_STATE_INVALID` (400)** — the state is
  unknown, already used, expired (10 min), or mismatched. Start the flow again
  from Settings; each link works once.
- **`GITHUB_MANIFEST_PERMISSIONS_DENIED` (422)** — the App GitHub created
  reports a required permission missing or at the wrong level (defensive; a
  report with no permissions is not a denial). Re-run **Connect GitHub App**.
- **`GITHUB_MANIFEST_EXCHANGE_FAILED` (502)** — GitHub refused the one-time code
  exchange (network/timeout/non-2xx). Retry the flow.
- **Link fails with `GITHUB_API_ERROR: GitHub App is not configured`** — no
  credentials reach the server: run the in-app connect flow (applies
  immediately).
- **Webhook deliveries never arrive** — check the app's delivery log
  (App settings → **Advanced**): `failed to connect to host` = wrong webhook
  URL (usually a stale `LXK_PUBLIC_URL` after a tunnel restart);
  `401` = secret mismatch (a re-run of **Connect GitHub App** replaced the App —
  the old webhook secret was dropped).
- **Closing an already-closed issue sends no webhook** — GitHub doesn't
  deliver no-op state changes. Reopen first to re-trigger.
- **A task that was moved while the issue was closed looks "Diverged"** —
  expected: out-of-sync is surfaced, not auto-healed; re-move the task to resync.
