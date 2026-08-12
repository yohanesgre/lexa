import { Effect, Data, Either } from "effect";
import { randomBytes } from "node:crypto";
import { Sqlite, DbError, ConstraintViolation } from "../db/database";
import type { Team, TeamMember, TeamMemberRole } from "../../shared/types";

export class TeamNotFound extends Data.TaggedError("TeamNotFound")<{ teamId: string }> {}
export class TeamHasProjects extends Data.TaggedError("TeamHasProjects")<{ teamId: string; count: number }> {}
export class SoleOwner extends Data.TaggedError("SoleOwner")<{ message: string }> {}
export class TeamMemberNotFound extends Data.TaggedError("TeamMemberNotFound")<{ userId: string }> {}
export class MemberNotInWorkspace extends Data.TaggedError("MemberNotInWorkspace")<{ email: string; available: string[] }> {}
export class TeamSlugTaken extends Data.TaggedError("TeamSlugTaken")<{ slug: string }> {}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}
interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

const toTeam = (r: OrgRow): Team => ({ id: r.id, name: r.name, slug: r.slug, createdAt: r.createdAt });
const toMember = (r: MemberRow): TeamMember => ({
  userId: r.userId,
  name: r.name,
  email: r.email,
  role: (r.role.split(",")[0].trim() || "member") as TeamMemberRole,
  createdAt: r.createdAt,
});

const slugify = (name: string): string => {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "team";
};

// Teams = Better Auth organization rows, managed via SQL (the org plugin's
// HTTP surface is closed: creation allow-listed, deletion disabled). Slug is
// UNIQUE; the server appends a random suffix unless the caller supplied one.
export class TeamsService extends Effect.Service<TeamsService>()("Lexa/TeamsService", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const insert = (name: string, slug: string, createdBy: string): Effect.Effect<Team, TeamSlugTaken | DbError> =>
      Effect.try({
        try: () => {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), name, slug, now);
          const org = db.prepare("SELECT id, name, slug, createdAt FROM organization WHERE slug = ?").get(slug) as OrgRow;
          db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)").run(crypto.randomUUID(), org.id, createdBy, now);
          return toTeam(org);
        },
        catch: (e) => {
          const msg = String(e);
          if (msg.includes("UNIQUE") || /constraint failed/i.test(msg)) return new TeamSlugTaken({ slug });
          return new DbError({ message: msg, cause: e });
        },
      });

    const create = (name: string, slug: string | undefined, createdBy: string): Effect.Effect<Team, TeamSlugTaken | DbError> =>
      Effect.gen(function* () {
        if (slug && slug.trim()) {
          return yield* insert(name.trim(), slug.trim().toLowerCase(), createdBy);
        }
        // Auto-slug: base + random suffix, retried on collision.
        for (let attempt = 0; attempt < 4; attempt++) {
          const candidate = `${slugify(name)}-${randomBytes(3).toString("hex")}`;
          const result = yield* Effect.either(insert(name.trim(), candidate, createdBy));
          if (Either.isRight(result)) return result.right;
          if (result.left instanceof TeamSlugTaken && attempt < 3) continue;
          return yield* Effect.fail(result.left);
        }
        return yield* Effect.fail(new DbError({ message: "slug generation exhausted" }));
      });

    const listAll = (): Effect.Effect<Team[], DbError> =>
      Effect.try({
        try: () => (db.prepare("SELECT id, name, slug, createdAt FROM organization ORDER BY createdAt DESC, rowid DESC").all() as OrgRow[]).map(toTeam),
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    const listForUser = (userId: string): Effect.Effect<Team[], DbError> =>
      Effect.try({
        try: () =>
          (db
            .prepare(
              "SELECT o.id, o.name, o.slug, o.createdAt FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? AND (m.role LIKE '%owner%' OR m.role LIKE '%admin%') ORDER BY o.createdAt DESC, o.rowid DESC"
            )
            .all(userId) as OrgRow[])
            .map(toTeam),
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    const findById = (teamId: string): Effect.Effect<Team | null, DbError> =>
      Effect.try({
        try: () => {
          const row = db.prepare("SELECT id, name, slug, createdAt FROM organization WHERE id = ?").get(teamId) as OrgRow | null;
          return row ? toTeam(row) : null;
        },
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    const remove = (teamId: string): Effect.Effect<void, TeamNotFound | TeamHasProjects | DbError> =>
      Effect.gen(function* () {
        const org = yield* Effect.try({
          try: () => db.prepare("SELECT id FROM organization WHERE id = ?").get(teamId) as OrgRow | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const owned = yield* Effect.try({
          try: () => (db.prepare("SELECT COUNT(*) c FROM projects WHERE team_id = ?").get(teamId) as { c: number }).c,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (owned > 0) return yield* Effect.fail(new TeamHasProjects({ teamId, count: owned }));
        yield* Effect.try({
          try: () => db.prepare("DELETE FROM organization WHERE id = ?").run(teamId),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
      });

    const members = (teamId: string): Effect.Effect<TeamMember[], TeamNotFound | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        return yield* Effect.try({
          try: () =>
            (db
              .prepare(
                "SELECT m.userId, u.name, u.email, m.role, m.createdAt FROM member m JOIN users u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.rowid"
              )
              .all(teamId) as MemberRow[])
              .map(toMember),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
      });

    const addMember = (teamId: string, email: string, role: TeamMemberRole): Effect.Effect<TeamMember, TeamNotFound | MemberNotInWorkspace | ConstraintViolation | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const normalized = email.trim().toLowerCase();
        const user = yield* Effect.try({
          try: () => db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(normalized) as { id: string; name: string; email: string } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!user) {
          const available = (db.prepare("SELECT email FROM users WHERE email LIKE ? ORDER BY email LIMIT 5").all(`%${normalized.split("@")[0]}%`) as { email: string }[]).map((r) => r.email);
          return yield* Effect.fail(new MemberNotInWorkspace({ email: normalized, available }));
        }
        const now = new Date().toISOString();
        yield* Effect.try({
          try: () =>
            db
              .prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)")
              .run(crypto.randomUUID(), teamId, user.id, role, now),
          catch: (e) => {
            const msg = String(e);
            if (msg.includes("UNIQUE") || /constraint failed/i.test(msg)) return new ConstraintViolation({ message: msg, isPositionConflict: false });
            return new DbError({ message: msg, cause: e });
          },
        });
        return { userId: user.id, name: user.name, email: user.email, role, createdAt: now };
      });

    const setMemberRole = (teamId: string, userId: string, role: TeamMemberRole): Effect.Effect<TeamMember, TeamNotFound | TeamMemberNotFound | SoleOwner | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const member = yield* Effect.try({
          try: () => db.prepare("SELECT userId, role FROM member WHERE organizationId = ? AND userId = ?").get(teamId, userId) as { userId: string; role: string } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!member) return yield* Effect.fail(new TeamMemberNotFound({ userId }));
        if (role !== "owner" && member.role.includes("owner")) {
          const ownerCount = yield* Effect.try({
            try: () => (db.prepare("SELECT COUNT(*) c FROM member WHERE organizationId = ? AND role LIKE '%owner%'").get(teamId) as { c: number }).c,
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          if (ownerCount <= 1) {
            return yield* Effect.fail(new SoleOwner({ message: "Cannot demote the last owner — transfer ownership first" }));
          }
        }
        yield* Effect.try({
          try: () => db.prepare("UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?").run(role, teamId, userId),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        const row = db.prepare("SELECT m.userId, u.name, u.email, m.role, m.createdAt FROM member m JOIN users u ON u.id = m.userId WHERE m.organizationId = ? AND m.userId = ?").get(teamId, userId) as MemberRow;
        return toMember(row);
      });

    const removeMember = (teamId: string, userId: string): Effect.Effect<void, TeamNotFound | TeamMemberNotFound | SoleOwner | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const member = yield* Effect.try({
          try: () => db.prepare("SELECT userId, role FROM member WHERE organizationId = ? AND userId = ?").get(teamId, userId) as { userId: string; role: string } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!member) return yield* Effect.fail(new TeamMemberNotFound({ userId }));
        if (member.role.includes("owner")) {
          const ownerCount = yield* Effect.try({
            try: () => (db.prepare("SELECT COUNT(*) c FROM member WHERE organizationId = ? AND role LIKE '%owner%'").get(teamId) as { c: number }).c,
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          if (ownerCount <= 1) {
            return yield* Effect.fail(new SoleOwner({ message: "Cannot remove the last owner — transfer ownership first" }));
          }
        }
        yield* Effect.try({
          try: () => db.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").run(teamId, userId),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
      });

    return { create, listAll, listForUser, findById, remove, members, addMember, setMemberRole, removeMember };
  }),
}) {}
