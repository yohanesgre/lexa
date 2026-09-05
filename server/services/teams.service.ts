import { Effect, Data, Either } from "effect";
import { randomBytes } from "node:crypto";
import { Db, DbError, ConstraintViolation, RowNotFound, queryAll, queryFirst, run } from "../db/db";
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
  role: ((r.role.split("!,")[0] ?? "").trim() || "member") as TeamMemberRole,
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
    const db = yield* Db;

    const firstOrNull = <T>(eff: Effect.Effect<T, RowNotFound | DbError>): Effect.Effect<T | null, DbError> =>
      eff.pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));

    const insert = (name: string, slug: string, createdBy: string): Effect.Effect<Team, TeamSlugTaken | DbError> =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        yield* run(db, "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)", crypto.randomUUID(), name, slug, now).pipe(
          Effect.catchTag("ConstraintViolation", () => Effect.fail(new TeamSlugTaken({ slug })))
        );
        const org = yield* queryFirst<OrgRow>(db, "SELECT id, name, slug, createdAt FROM organization WHERE slug = ?", slug).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: `team row vanished after insert slug=${slug}` })))
        );
        yield* run(db, "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)", crypto.randomUUID(), org.id, createdBy, now).pipe(
          Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e))
        );
        return toTeam(org);
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
      queryAll<OrgRow>(db, "SELECT id, name, slug, createdAt FROM organization ORDER BY createdAt DESC, rowid DESC").pipe(
        Effect.map((rows) => rows.map(toTeam))
      );

    const listForUser = (userId: string): Effect.Effect<Team[], DbError> =>
      queryAll<OrgRow>(
        db,
        "SELECT o.id, o.name, o.slug, o.createdAt FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? AND (m.role LIKE '%owner%' OR m.role LIKE '%admin%') ORDER BY o.createdAt DESC, o.rowid DESC",
        userId
      ).pipe(Effect.map((rows) => rows.map(toTeam)));

    const findById = (teamId: string): Effect.Effect<Team | null, DbError> =>
      firstOrNull(queryFirst<OrgRow>(db, "SELECT id, name, slug, createdAt FROM organization WHERE id = ?", teamId)).pipe(
        Effect.map((row) => (row ? toTeam(row) : null))
      );

    const remove = (teamId: string): Effect.Effect<void, TeamNotFound | TeamHasProjects | DbError> =>
      Effect.gen(function* () {
        const org = yield* firstOrNull(queryFirst<OrgRow>(db, "SELECT id FROM organization WHERE id = ?", teamId));
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const owned = yield* queryFirst<{ c: number }>(db, "SELECT COUNT(*) c FROM projects WHERE team_id = ?", teamId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed({ c: 0 }))
        );
        if (owned.c > 0) return yield* Effect.fail(new TeamHasProjects({ teamId, count: owned.c }));
        // runtimes are ephemeral infra — unassign them (fresh DBs get
        // ON DELETE SET NULL from the FK; this explicit clear also covers
        // DBs migrated before that FK action existed).
        yield* run(db, "UPDATE runtimes SET team_id = NULL WHERE team_id = ?", teamId).pipe(
          Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e))
        );
        yield* run(db, "DELETE FROM organization WHERE id = ?", teamId).pipe(
          Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e))
        );
      });

    const members = (teamId: string): Effect.Effect<TeamMember[], TeamNotFound | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        return yield* queryAll<MemberRow>(
          db,
          "SELECT m.userId, u.name, u.email, m.role, m.createdAt FROM member m JOIN users u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.rowid",
          teamId
        ).pipe(Effect.map((rows) => rows.map(toMember)));
      });

    const addMember = (teamId: string, email: string, role: TeamMemberRole): Effect.Effect<TeamMember, TeamNotFound | MemberNotInWorkspace | ConstraintViolation | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const normalized = email.trim().toLowerCase();
        const user = yield* firstOrNull(
          queryFirst<{ id: string; name: string; email: string }>(db, "SELECT id, name, email FROM users WHERE email = ?", normalized)
        );
        if (!user) {
          const available = yield* queryAll<{ email: string }>(db, "SELECT email FROM users WHERE email LIKE ? ORDER BY email LIMIT 5", `%${normalized.split("@")[0]}%`).pipe(
            Effect.map((rows) => rows.map((r) => r.email))
          );
          return yield* Effect.fail(new MemberNotInWorkspace({ email: normalized, available }));
        }
        const now = new Date().toISOString();
        yield* run(db, "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), teamId, user.id, role, now);
        return { userId: user.id, name: user.name, email: user.email, role, createdAt: now };
      });

    const setMemberRole = (teamId: string, userId: string, role: TeamMemberRole): Effect.Effect<TeamMember, TeamNotFound | TeamMemberNotFound | SoleOwner | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const member = yield* firstOrNull(
          queryFirst<{ userId: string; role: string }>(db, "SELECT userId, role FROM member WHERE organizationId = ? AND userId = ?", teamId, userId)
        );
        if (!member) return yield* Effect.fail(new TeamMemberNotFound({ userId }));
        if (role !== "owner" && member.role.includes("owner")) {
          const ownerCount = yield* queryFirst<{ c: number }>(db, "SELECT COUNT(*) c FROM member WHERE organizationId = ? AND role LIKE '%owner%'", teamId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed({ c: 0 }))
          );
          if (ownerCount.c <= 1) {
            return yield* Effect.fail(new SoleOwner({ message: "Cannot demote the last owner — transfer ownership first" }));
          }
        }
        yield* run(db, "UPDATE member SET role = ? WHERE organizationId = ? AND userId = ?", role, teamId, userId).pipe(
          Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e))
        );
        const row = yield* queryFirst<MemberRow>(
          db,
          "SELECT m.userId, u.name, u.email, m.role, m.createdAt FROM member m JOIN users u ON u.id = m.userId WHERE m.organizationId = ? AND m.userId = ?",
          teamId, userId
        ).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new TeamMemberNotFound({ userId }))));
        return toMember(row);
      });

    const removeMember = (teamId: string, userId: string): Effect.Effect<void, TeamNotFound | TeamMemberNotFound | SoleOwner | DbError> =>
      Effect.gen(function* () {
        const org = yield* findById(teamId);
        if (!org) return yield* Effect.fail(new TeamNotFound({ teamId }));
        const member = yield* firstOrNull(
          queryFirst<{ userId: string; role: string }>(db, "SELECT userId, role FROM member WHERE organizationId = ? AND userId = ?", teamId, userId)
        );
        if (!member) return yield* Effect.fail(new TeamMemberNotFound({ userId }));
        if (member.role.includes("owner")) {
          const ownerCount = yield* queryFirst<{ c: number }>(db, "SELECT COUNT(*) c FROM member WHERE organizationId = ? AND role LIKE '%owner%'", teamId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed({ c: 0 }))
          );
          if (ownerCount.c <= 1) {
            return yield* Effect.fail(new SoleOwner({ message: "Cannot remove the last owner — transfer ownership first" }));
          }
        }
        yield* run(db, "DELETE FROM member WHERE organizationId = ? AND userId = ?", teamId, userId).pipe(
          Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e))
        );
      });

    return { create, listAll, listForUser, findById, remove, members, addMember, setMemberRole, removeMember };
  }),
}) {}
