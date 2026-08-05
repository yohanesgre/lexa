import { createHash, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";

export interface ApiKeyIdentity {
  keyId: string;
  userId: string | null;
  role: "admin" | "member";
}

// Resolve the caller behind an Authorization header against a shared
// connection: key → user (null user means a setup/seeded key — admin).
// Mirrors the MCP auth rule so REST and MCP enforce the same role model.
export function resolveApiKeyIdentity(authHeader: string, db: Database): ApiKeyIdentity | null {
  if (!authHeader.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7);
  if (!key.startsWith("lxk_") || !/^lxk_[0-9A-Za-z]{43}$/.test(key)) return null;
  const keyHash = createHash("sha256").update(key).digest("hex");
  try {
    const row = db.prepare("SELECT id, user_id FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | { id: string; user_id: string | null }
      | undefined;
    if (!row) return null;
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))").run(row.id);
    if (!row.user_id) return { keyId: row.id, userId: null, role: "admin" };
    const user = db.prepare("SELECT role FROM users WHERE id = ?").get(row.user_id) as { role: "admin" | "member" } | undefined;
    if (!user) return null;
    return { keyId: row.id, userId: row.user_id, role: user.role };
  } catch {
    return null;
  }
}

// Constant-time comparison (sha256 digest length is fixed, so timingSafeEqual
// never sees mismatched buffers).
export function constantTimeTokenEqual(a: string, b: string): boolean {
  const hexA = createHash("sha256").update(a).digest("hex");
  const hexB = createHash("sha256").update(b).digest("hex");
  const bufA = Buffer.from(hexA, "hex");
  const bufB = Buffer.from(hexB, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
