import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

export function verifyApiKey(req: Request, dbPath: string): boolean {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const key = authHeader.slice(7);
  if (!key.startsWith("lxk_") || !/^lxk_[0-9A-Za-z]{43}$/.test(key)) return false;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const row = db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(keyHash);
    if (!row) return false;
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))").run((row as { id: string }).id);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
