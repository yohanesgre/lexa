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
