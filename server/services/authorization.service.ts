import { Effect } from "effect";
import { Sqlite, DbError } from "../db/database";

export type ProjectAccessRole = "admin" | "member";

// Project-access + team/settings gates (R8/R14). The decision order is
// pinned by the spec: superadmin > explicit user_project_roles grant > team
// membership > deny. Team-admin authority comes from the org member role
// (owner/admin) on the team — never from users.role; superadmin exceeds org
// roles everywhere.
export class AuthorizationService extends Effect.Service<AuthorizationService>()("Lexa/AuthorizationService", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const isSuperadmin = (userId: string): Effect.Effect<boolean, DbError> =>
      Effect.try({
        try: () => {
          const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | null;
          return row?.role === "superadmin";
        },
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    // Org role owner/admin on that team = team admin.
    const isTeamAdmin = (userId: string, teamId: string): Effect.Effect<boolean, DbError> =>
      Effect.try({
        try: () => {
          const row = db
            .prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?")
            .get(teamId, userId) as { role: string } | null;
          if (!row) return false;
          const roles = row.role.split(",").map((r) => r.trim());
          return roles.includes("owner") || roles.includes("admin");
        },
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    // Project access decision:
    //   1. superadmin                    → "admin"
    //   2. user_project_roles grant      → grant role (admin|member)
    //   3. member of the project's team  → org owner/admin ? "admin" : "member"
    //   4. else                          → null (deny)
    const projectAccess = (userId: string, projectId: string): Effect.Effect<ProjectAccessRole | null, DbError> =>
      Effect.gen(function* () {
        if (yield* isSuperadmin(userId)) return "admin" as const;
        const grant = yield* Effect.try({
          try: () =>
            db.prepare("SELECT role FROM user_project_roles WHERE user_id = ? AND project_id = ?").get(userId, projectId) as
              | { role: "admin" | "member" }
              | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (grant) return grant.role;
        const team = yield* Effect.try({
          try: () => db.prepare("SELECT team_id FROM projects WHERE id = ?").get(projectId) as { team_id: string | null } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!team?.team_id) return null; // unassigned → superadmin-only (already ruled out)
        const member = yield* Effect.try({
          try: () =>
            db.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?").get(team.team_id, userId) as
              | { role: string }
              | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
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
