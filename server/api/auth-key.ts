import { createHash, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { findOrCreateUserByIdentity } from "./auth";

export interface ApiKeyIdentity {
  keyId: string;
  keyName: string;
  userId: string | null;
  userName: string | null;
  role: "admin" | "member";
}

// Resolve the caller behind an Authorization header against a shared
// connection: key → user (null user means a setup/seeded key — admin).
// Mirrors the MCP auth rule so REST and MCP enforce the same role model.
// Attribution enrichment: the browser sends x-lxk-user (the Cloudflare
// Access email) so activity rows can be attributed to the acting user —
// role NEVER comes from the header (authz stays key-based; the header only
// names the actor. Spoofable by key holders, accepted: the key already
// grants full access).
export function resolveApiKeyIdentity(authHeader: string, headers: Headers, db: Database, dbPath: string): ApiKeyIdentity | null {
  if (!authHeader.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7);
  if (!key.startsWith("lxk_") || !/^lxk_[0-9A-Za-z]{43}$/.test(key)) return null;
  const keyHash = createHash("sha256").update(key).digest("hex");
  try {
    const row = db.prepare("SELECT id, name, user_id FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | { id: string; name: string; user_id: string | null }
      | undefined;
    if (!row) return null;
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))").run(row.id);
    let userId: string | null = null;
    let userName: string | null = null;
    let role: "admin" | "member" = "admin";
    if (row.user_id) {
      const user = db.prepare("SELECT role FROM users WHERE id = ?").get(row.user_id) as { role: "admin" | "member" } | undefined;
      if (!user) return null;
      role = user.role;
      userId = row.user_id;
    }
    const headerEmail = headers.get("x-lxk-user")?.trim() ?? "";
    if (headerEmail) {
      const user = findOrCreateUserByIdentity(headerEmail, headerEmail.split("@")[0], dbPath);
      if (user) {
        userId = user.id;
        userName = user.name;
      }
    }
    return { keyId: row.id, keyName: row.name, userId, userName, role };
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
