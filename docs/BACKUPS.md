# Backups — Setup & Restore

Nightly DB backups, opt-in via env. Each run takes a consistent SQLite
snapshot (`VACUUM INTO`), gzips it, and uploads it through the storage driver
under `backups/`. Retention prunes old snapshots automatically. Restoring is a
manual procedure (§4) — Lexa never restores on its own.

## 1. What a backup contains

Every run writes one snapshot key:

```
backups/lexa-<ISO stamp>.db.gz
```

The stamp is fixed-width ISO with `:`/`.` replaced by `-`
(e.g. `lexa-2026-08-22T03-00-00-000Z.db.gz`) so lexical sort == chronological
sort — retention relies on this.

With the **fs** storage driver the run additionally copies the blob dir into
the backup set, so a restore is self-contained:

```
backups/lexa-<stamp>-blobs/<sha256>
```

S3 buckets hold their own object copies — no `-blobs/` companions there.

**A backup carries the CIPHERTEXT of managed secrets, never the master key.**
Credentials entered in the webapp — MCP client tokens
(`assistant_mcp_secrets`, migration `0011`), the Jev API key
(`assistant_jev_secrets`, migration `0013`), and LLM provider API keys
(`assistant_provider_secrets`, migration `0014`) — are stored AES-256-GCM
encrypted, so a snapshot taken after the corresponding migration includes those
rows; the envelope key
(`LXK_SECRETS_MASTER_KEY`, and its read-only `LXK_SECRETS_MASTER_KEY_PREV`) lives only in
the server environment and is never written to a backup, a D1 export, or any
other artifact this process produces. **Keep the two apart: the master key must
never be co-located with the backups** — not in the same bucket, volume, host,
or encrypted archive. Restoring a database elsewhere, or copying a snapshot to a
third-party store, therefore hands over ciphertext that nobody but a holder of
the key can open. This is the whole basis of the security claim behind managed
secrets: it holds **only** under that separation, so a backup set plus its key
is exactly as sensitive as the plaintext secrets it replaces, and must be guarded
accordingly. Losing the key with no `LXK_SECRETS_MASTER_KEY_PREV` fallback is
permanent loss of every stored secret (they can be re-entered; nothing else can
recover them). See `docs/DEPLOYMENT.md` for the variable reference and rotation.

## 2. Enable

Set in `.env.toml` (or a legacy flat `.env` for one release):

```bash
LXK_BACKUP_ENABLED=1
```

Behavior when enabled (`server/entry.ts`):

- Runs **once at boot**, then every **24h**.
- After each run, retention keeps the newest `N` snapshots and deletes the
  older `.db.gz` keys plus their `-blobs/` companions.
- Failures are logged (`[Backup] failed: …`) and never crash the server.

## 3. Environment variables

| Var | Meaning |
| --- | --- |
| `LXK_BACKUP_ENABLED` | `1` to enable nightly backups (default: off) |
| `LXK_BACKUP_RETENTION` | Snapshots to keep before pruning the oldest (default: `14`) |
| `LXK_STORAGE_DRIVER` | `fs` (default) or `s3` — where backups and blobs live |
| `LXK_S3_ENDPOINT` | S3-compatible endpoint (e.g. R2/MinIO); omit for AWS |
| `LXK_S3_BUCKET` | Bucket name — required when driver is `s3` |
| `LXK_S3_ACCESS_KEY_ID` | S3 access key — required when driver is `s3` |
| `LXK_S3_SECRET_ACCESS_KEY` | S3 secret key — required when driver is `s3` |
| `LXK_MAX_UPLOAD_MB` | Attachment upload cap in MB (default: `25`) — not backup-specific, listed for completeness |

`s3` also requires all three of `LXK_S3_BUCKET`, `LXK_S3_ACCESS_KEY_ID` and
`LXK_S3_SECRET_ACCESS_KEY` at boot — the server refuses to start otherwise.

## 4. Restore procedure (Bun host)

Snapshot restore applies only to the Bun host, where the DB is a local
`data/lexa.db` file. Workers has no local DB; its backups are managed by
D1 point-in-time recovery instead.

1. **Stop the server process** so nothing writes during the restore.
2. **Fetch the snapshot** you want from the storage location:
   - fs driver: `<volume>/backups/lexa-<ts>.db.gz`
   - s3 driver: `s3://<bucket>/backups/lexa-<ts>.db.gz`
   Pick the newest (stamps sort chronologically) unless restoring to a point
   in time.
3. **Gunzip** it:
   ```bash
   gunzip -c lexa-<ts>.db.gz > lexa.db
   ```
4. **Replace the live DB**: copy `lexa.db` over `data/lexa.db` (remove stale
   `data/lexa.db-wal` / `data/lexa.db-shm` if present).
5. **fs driver only**: restore the blob dir — copy everything from
   `backups/lexa-<ts>-blobs/` into `data/blobs/` (the same matching-stamp
   companion set from §1). Skip for s3 — objects never left the bucket.
6. **Restart the server.** Migrations run at boot and are a no-op — the
   snapshot already carries the current schema. The restoring host must have
   `LXK_SECRETS_MASTER_KEY` (and `LXK_SECRETS_MASTER_KEY_PREV`, if the snapshot predates a
   finished rotation) set in **its own** environment — the key is not in the
   snapshot (§1), so a restore onto a host without it brings back stored secrets
   that cannot be opened (MCP tokens and provider/Jev keys fail until each is
   re-entered; everything else is unaffected).
7. **Verify**: `curl http://localhost:3000/api/health` → `{"ok":true}`, then
   spot-check boards/attachments in the UI.

## 5. Orphan blobs

Two paths can leave blobs on disk/S3 that no row references:

- FK cascades delete attachment rows while their blob files remain;
- a crash between the blob `put` and the attachment row insert.

These orphans are **harmless by design**: there is no garbage collector.
Re-uploading the same content re-links by sha256 (content-addressed keys), so
an orphan becomes referenced again instead of duplicating. Empty `-blobs/`
directories may linger after retention pruning — deletion removes files only,
never directories.

## 6. One-time Markdown content conversion

Schema migration `0030` changes empty defaults and creates the format/journal
tables only. It does not convert document bodies at boot. This representation
change is breaking: after apply, legacy TipTap-object API payloads are rejected.

Use this order during the maintenance window:

1. Stop application, webhook, assistant, and other database writers; keep request
   traffic gated through post-apply verification.
2. Create and restore-test a database backup plus matching blob backup.
3. Run `audit`; inspect its report and resolve every blocker before proceeding.
4. Create the SHA-256 manifest for that exact backup and target.
5. Run `apply` with the audit report and manifest.
6. Verify `documents.format`, source/journal consistency, `content_text`, and FTS;
   only then reopen traffic on the matching application version.

Audit queries application data with SELECT statements only. The Wrangler proxy
used for D1 is nevertheless read/write-capable and may create temporary config,
local session, or persistence metadata. Audit is not credential-enforced
read-only and does not promise zero filesystem writes. It does not pass SQL
through argv.

For D1, the CLI reads the first `d1_databases` entry in Wrangler config. Its
`binding`, `database_name`, and `database_id`, plus a valid
`compatibility_date`, must be configured; `--database-name` must match that
first binding. Select exactly one of `--local` or `--remote`. Local requires
`--persist-to` as the Wrangler state root and forbids `--database-id`; the
proxy stores D1 state under `<persist-to>/v3`. Remote requires
`--database-id` matching the configured ID. The minimum Cloudflare token
permissions were not verified; do not assume a D1-only token is sufficient.

```bash
# SQLite
bun run scripts/migrate-markdown.ts audit \
  --sqlite /absolute/path/lexa.db \
  --report /absolute/path/markdown-audit.json
bun run scripts/migrate-markdown.ts apply \
  --sqlite /absolute/path/lexa.db \
  --audit /absolute/path/markdown-audit.json \
  --backup-manifest /absolute/path/markdown-backup.json \
  --batch-size 25

# Local D1 — explicit, isolated persistence directory
bun run scripts/migrate-markdown.ts audit \
  --d1-config /absolute/path/wrangler.jsonc \
  --database-name lexa --local \
  --persist-to /absolute/path/d1-markdown-rehearsal \
  --report /absolute/path/markdown-audit.json
bun run scripts/migrate-markdown.ts apply \
  --d1-config /absolute/path/wrangler.jsonc \
  --database-name lexa --local \
  --persist-to /absolute/path/d1-markdown-rehearsal \
  --audit /absolute/path/markdown-audit.json \
  --backup-manifest /absolute/path/markdown-backup.json \
  --batch-size 25

# Remote D1 — requires the exact configured database ID
bun run scripts/migrate-markdown.ts audit \
  --d1-config /absolute/path/wrangler.jsonc \
  --database-name lexa --remote --database-id <configured-uuid> \
  --report /absolute/path/markdown-audit.json
bun run scripts/migrate-markdown.ts apply \
  --d1-config /absolute/path/wrangler.jsonc \
  --database-name lexa --remote --database-id <configured-uuid> \
  --audit /absolute/path/markdown-audit.json \
  --backup-manifest /absolute/path/markdown-backup.json \
  --batch-size 25
```

Apply refuses a dirty/stale audit, target mismatch, or missing/invalid backup
evidence. A manifest uses this exact shape; hash the artifact itself with
SHA-256 and record a restore test on a separate target:

```json
{
  "format": "lexa-markdown-backup/v1",
  "target_id": "sqlite:/absolute/path/lexa.db",
  "created_at": "2026-10-14T12:00:00.000Z",
  "artifact": {
    "kind": "sqlite-snapshot",
    "path": "/absolute/path/pre-markdown.db",
    "sha256": "<64 lowercase hex characters>"
  },
  "restore_tested": true,
  "restore_tested_at": "2026-10-14T12:30:00.000Z",
  "restored_to_target_id": "sqlite:/absolute/path/isolated-restore.db",
  "includes_blobs": true
}
```

For D1, set `target_id` to
`d1-local:<absolute-config>:<database-name>:<absolute-persist-dir>` or
`d1-remote:<database-id>`. Remote D1 requires `"kind": "d1-export"`; a local
SQLite snapshot is never remote D1 restore evidence.

Local D1 also accepts `"kind": "sqlite-snapshot"`. Stop the local Worker and
all D1 writers, locate the selected persistence directory's actual D1 SQLite
file, and take a consistent snapshot with `sqlite3 <database> ".backup '<snapshot>'"`.
Restore that snapshot into a separate persistence directory using the same
database binding, then verify it through real local Wrangler D1 queries.
Do not copy an active SQLite file without its WAL or label a SQLite snapshot
as a D1 SQL export. The pinned Wrangler export command does not accept
`--persist-to`; snapshots avoid exporting the wrong local persistence target.

Include the matching blob backup in the restore evidence (verify an empty
blob set explicitly). Audit reports contain row keys and source/target hashes,
never body text. Unsupported or malformed legacy content blocks all apply
writes. Apply writes source-CAS updates with matching hash-only
`_markdown_migration` markers in bounded atomic batches (default 25, maximum
50); interruptions resume from the journal. Request traffic stays gated until
post-write, `content_text`, and FTS consistency checks pass and
`documents.format` becomes `markdown-v1`. Reapplying a completed database does
not parse source content.
