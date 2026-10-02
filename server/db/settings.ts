import { Database } from "bun:sqlite";

export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(key, value);
}

export function deleteSetting(db: Database, key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// Env → settings-DB bootstrap mirror, run ONCE at boot. The DB is the single
// source of truth at runtime; env only provisions first boot. Each mapping is
// written when the DB key is absent/empty AND the env value is truthy —
// existing DB values are NEVER overwritten (a cleared key is re-imported from
// env at the next boot). GitHub config is never mirrored: it is written only
// by the web app. Returns the list of mirrored settings keys (for boot
// logging).
export function mirrorSettingsFromEnv(
  db: Database,
  env: Record<string, string | undefined>
): string[] {
  const mirrored: string[] = [];
  const isAbsent = (key: string): boolean => {
    const v = getSetting(db, key);
    return v === null || v === "";
  };
  const mirror = (dbKey: string, value: string | undefined): void => {
    if (!value) return;
    if (!isAbsent(dbKey)) return;
    setSetting(db, dbKey, value);
    mirrored.push(dbKey);
  };

  mirror("rate_limit_max", env.LXK_RATE_LIMIT_MAX);
  mirror("rate_limit_window_ms", env.LXK_RATE_LIMIT_WINDOW_MS);
  mirror("assistant_repo_cap", env.LXK_ASSISTANT_REPO_CAP);
  return mirrored;
}
