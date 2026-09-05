import { Effect } from "effect";
import { Db, DbError, RowNotFound, queryFirst } from "../db/db";

export type ProjectAccessRole = "admin" | "member";

const firstOrNull = <T>(eff: Effect.Effect<T, RowNotFound | DbError>): Effect.Effect<T | null, DbError> =>
  eff.pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));

// Project-access + team/settings gates (R8/R14). The decision order is
// pinned by the spec: superadmin > explicit user_project_roles grant > team
// membership > deny. Team-admin authority comes from the org member role
// (owner/admin) on the team — never from users.role; superadmin exceeds org
// roles everywhere.
export class AuthorizationService extends Effect.Service<AuthorizationService>()("Lexa/AuthorizationService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const isSuperadmin = (userId: string): Effect.Effect<boolean, DbError> =>
      firstOrNull(queryFirst<{ role: string }>(db, "SELECT role FROM users WHERE id = ?", userId)).pipe(
        Effect.map((row) => row?.role === "superadmin")
      );

    // Org role owner/admin on that team = team admin.
    const isTeamAdmin = (userId: string, teamId: string): Effect.Effect<boolean, DbError> =>
      firstOrNull(
        queryFirst<{ role: string }>(db, "SELECT role FROM member WHERE organizationId = ? AND userId = ?", teamId, userId)
      ).pipe(
        Effect.map((row) => {
          if (!row) return false;
          const roles = row.role.split(",").map((r) => r.trim());
          return roles.includes("owner") || roles.includes("admin");
        })
      );

    // Project access decision:
    //   1. superadmin                    → "admin"
    //   2. user_project_roles grant      → grant role (admin|member)
    //   3. member of the project's team  → org owner/admin ? "admin" : "member"
    //   4. else                          → null (deny)
    const projectAccess = (userId: string, projectId: string): Effect.Effect<ProjectAccessRole | null, DbError> =>
      Effect.gen(function* () {
        if (yield* isSuperadmin(userId)) return "admin" as const;
        const grant = yield* firstOrNull(
          queryFirst<{ role: "admin" | "member" }>(db, "SELECT role FROM user_project_roles WHERE user_id = ? AND project_id = ?", userId, projectId)
        );
        if (grant) return grant.role;
        const team = yield* firstOrNull(
          queryFirst<{ team_id: string | null }>(db, "SELECT team_id FROM projects WHERE id = ?", projectId)
        );
        if (!team?.team_id) return null; // unassigned → superadmin-only (already ruled out)
        const member = yield* firstOrNull(
          queryFirst<{ role: string }>(db, "SELECT role FROM member WHERE organizationId = ? AND userId = ?", team.team_id, userId)
        );
        if (!member) return null;
        const roles = member.role.split(",").map((r) => r.trim());
        return roles.includes("owner") || roles.includes("admin") ? "admin" : "member";
      });

    // Team gate: superadmin, or org owner/admin on that team.
    const canManageTeam = (userId: string, teamId: string): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        if (yield* isSuperadmin(userId)) return true;
        return yield* isTeamAdmin(userId, teamId);
      });

    // Settings gate (R14): superadmin only.
    const canManageSettings = isSuperadmin;

    return { isSuperadmin, isTeamAdmin, projectAccess, canManageTeam, canManageSettings };
  }),
}) {}
