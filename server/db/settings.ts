import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

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
// env at the next boot). GITHUB_PRIVATE_KEY_FILE is read at mirror time (its
// content is stored; an unreadable path is skipped with a warn). Inline
// GITHUB_PRIVATE_KEY wins over the file when both are set. Returns the list
// of mirrored settings keys (for boot logging).
export function mirrorSettingsFromEnv(
  db: Database,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8")
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

  mirror("github_app_id", env.GITHUB_APP_ID);
  mirror("github_webhook_secret", env.GITHUB_WEBHOOK_SECRET);
  if (env.GITHUB_PRIVATE_KEY) {
    mirror("github_private_key", env.GITHUB_PRIVATE_KEY);
  } else if (env.GITHUB_PRIVATE_KEY_FILE && isAbsent("github_private_key")) {
    try {
      mirror("github_private_key", readFile(env.GITHUB_PRIVATE_KEY_FILE));
    } catch {
      console.warn(`[Settings] GITHUB_PRIVATE_KEY_FILE unreadable (${env.GITHUB_PRIVATE_KEY_FILE}) — skipping mirror`);
    }
  }
  mirror("rate_limit_max", env.LXK_RATE_LIMIT_MAX);
  mirror("rate_limit_window_ms", env.LXK_RATE_LIMIT_WINDOW_MS);
  mirror("hearth_repo_cap", env.LXK_HEARTH_REPO_CAP);
  return mirrored;
}
