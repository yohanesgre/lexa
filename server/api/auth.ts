import { Database } from "bun:sqlite";

export interface LexaUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export function findOrCreateUser(req: Request, dbPath: string): LexaUser | null {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email");
  if (!email) return null;

  const name = req.headers.get("Cf-Access-Authenticated-User-Name") || email.split("@")[0];

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    const existing = db.prepare("SELECT id, email, name, role FROM users WHERE email = ?").get(email) as LexaUser | null;
    if (existing) {
      db.prepare("UPDATE users SET last_seen = datetime('now') WHERE email = ?").run(email);
      return existing;
    }

    const adminEmails = (process.env.LXK_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase());
    const role = adminEmails.includes(email.toLowerCase()) ? "admin" : "member";

    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, name, role, last_seen) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(id, email, name, role);
    return { id, email, name, role } as LexaUser;
  } finally {
    db.close();
  }
}
