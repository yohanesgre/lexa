import { Database } from "bun:sqlite";
import { Context } from "effect";
import { getSetting } from "../db/settings";
import type { Actor } from "../../shared/types";

// Caller identity behind a validated API key, resolved once per request by
// the API middleware and consumed by admin-gated handlers. Attribution only:
// role comes exclusively from the key (or its owner) — the x-lxk-user header
// never changes it, it only names the acting browser user (spoofable by key
// holders, accepted: the key already grants full access).
export interface AuthIdentityShape {
  keyId: string;
  keyName: string;
  userId: string | null;
  userName: string | null;
  role: "admin" | "member";
}
export class AuthIdentity extends Context.Tag("Lexa/AuthIdentity")<AuthIdentity, AuthIdentityShape>() {}

// Build the activity-timeline actor for a resolved identity: browser users
// (x-lxk-user header) attribute as 'user', bare API keys as 'agent' with the
// key name as label.
export function actorFromIdentity(identity: AuthIdentityShape): Actor {
  return {
    kind: identity.userId ? "user" : "agent",
    label: identity.userName ?? identity.keyName,
    userId: identity.userId,
  };
}

export interface LexaUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export function adminEmails(db: Database): string[] {
  const envEmails = (process.env.LXK_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const settingsEmails = (getSetting(db, "admin_emails") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...envEmails, ...settingsEmails])];
}

export function findOrCreateUser(req: Request, dbPath: string): LexaUser | null {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email");
  if (!email) return null;

  const name = req.headers.get("Cf-Access-Authenticated-User-Name") || email.split("@")[0];

  return findOrCreateUserByIdentity(email, name, dbPath);
}

export function findOrCreateUserByIdentity(email: string, name: string, dbPath: string): LexaUser | null {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const existing = db.prepare("SELECT id, email, name, role FROM users WHERE email = ?").get(email) as LexaUser | null;
    if (existing) {
      db.prepare("UPDATE users SET last_seen = datetime('now') WHERE email = ?").run(email);
      return existing;
    }

    const role = adminEmails(db).includes(email.toLowerCase()) ? "admin" : "member";

    const id = crypto.randomUUID();
    try {
      db.prepare("INSERT INTO users (id, email, name, role, last_seen) VALUES (?, ?, ?, ?, datetime('now'))")
        .run(id, email, name, role);
    } catch (e) {
      // Duplicate-email race: another request created the user between our
      // SELECT and INSERT. Re-read instead of surfacing the raw SqliteError
      // (entry.ts calls this outside the API error mapping path).
      const existing = db.prepare("SELECT id, email, name, role FROM users WHERE email = ?").get(email) as LexaUser | null;
      if (existing) return existing;
      throw e;
    }
    return { id, email, name, role } as LexaUser;
  } finally {
    db.close();
  }
}
