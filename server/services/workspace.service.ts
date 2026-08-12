import { Effect, Data } from "effect";
import { Sqlite, DbError } from "../db/database";
import { WorkspaceInvitesService } from "./workspace-invites.service";
import { PasswordLinksService } from "./password-links.service";
import type { LexaUser, TeamMemberRole } from "../../shared/types";

export class WorkspaceUserNotFound extends Data.TaggedError("WorkspaceUserNotFound")<{ userId: string }> {}
export class CannotDeleteSelf extends Data.TaggedError("CannotDeleteSelf")<{ message: string }> {}
export class CannotDeactivateSelf extends Data.TaggedError("CannotDeactivateSelf")<{ message: string }> {}

export interface WorkspaceMember extends LexaUser {
  teams: { teamId: string; teamName: string; role: TeamMemberRole }[];
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "superadmin" | "member";
  created_at: string;
  last_seen: string | null;
  banned: number;
}

const toUser = (r: UserRow): LexaUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  createdAt: r.created_at,
  lastSeen: r.last_seen,
});

// Workspace = the app's member base (all users). Superadmin-only surface.
// Deactivate = ban: better-auth's admin-plugin session-create hook rejects
// new sessions for banned users (spike-verified) — the column is the truth,
// so key callers (no session) can deactivate too. Delete = memberships +
// grants cascade (FK CASCADE), bound api_keys are revoked explicitly
// (api_keys.user_id has no ON DELETE action — RESTRICT otherwise).
export class WorkspaceService extends Effect.Service<WorkspaceService>()("Lexa/WorkspaceService", {
  dependencies: [WorkspaceInvitesService.Default, PasswordLinksService.Default],
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;
    const invites = yield* WorkspaceInvitesService;
    const passwordLinks = yield* PasswordLinksService;

    const findUser = (userId: string): Effect.Effect<UserRow | null, DbError> =>
      Effect.try({
        try: () => db.prepare("SELECT id, email, name, role, created_at, last_seen, banned FROM users WHERE id = ?").get(userId) as UserRow | null,
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    const listMembers = (): Effect.Effect<WorkspaceMember[], DbError> =>
      Effect.try({
        try: () => {
          const users = db.prepare("SELECT id, email, name, role, created_at, last_seen, banned FROM users ORDER BY created_at DESC, rowid DESC").all() as UserRow[];
          const teamRows = db
            .prepare(
              "SELECT m.userId, o.id AS teamId, o.name AS teamName, m.role FROM member m JOIN organization o ON o.id = m.organizationId ORDER BY o.name"
            )
            .all() as { userId: string; teamId: string; teamName: string; role: string }[];
          const byUser = new Map<string, WorkspaceMember["teams"]>();
          for (const t of teamRows) {
            const entry = byUser.get(t.userId) ?? [];
            entry.push({ teamId: t.teamId, teamName: t.teamName, role: (t.role.split(",")[0].trim() || "member") as TeamMemberRole });
            byUser.set(t.userId, entry);
          }
          return users.map((u) => ({ ...toUser(u), teams: byUser.get(u.id) ?? [] }));
        },
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    // Deactivate/reactivate (R16): the banned column is better-auth's own
    // admin-plugin marker — setting it blocks login + new sessions.
    const setActive = (userId: string, active: boolean): Effect.Effect<LexaUser, WorkspaceUserNotFound | DbError> =>
      Effect.gen(function* () {
        const user = yield* findUser(userId);
        if (!user) return yield* Effect.fail(new WorkspaceUserNotFound({ userId }));
        yield* Effect.try({
          try: () => db.prepare("UPDATE users SET banned = ?, banReason = ?, banExpires = NULL WHERE id = ?").run(active ? 0 : 1, active ? null : "deactivated by superadmin", userId),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        const updated = yield* findUser(userId);
        return toUser(updated!);
      });

    const removeUser = (userId: string): Effect.Effect<void, WorkspaceUserNotFound | CannotDeleteSelf | DbError> =>
      Effect.gen(function* () {
        const user = yield* findUser(userId);
        if (!user) return yield* Effect.fail(new WorkspaceUserNotFound({ userId }));
        if (user.role === "superadmin") {
          const total = yield* Effect.try({
            try: () => (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'superadmin'").get() as { c: number }).c,
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          if (total <= 1) {
            return yield* Effect.fail(new CannotDeleteSelf({ message: "Cannot delete the last superadmin" }));
          }
        }
        yield* Effect.try({
          try: () => {
            db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
            db.prepare("DELETE FROM users WHERE id = ?").run(userId);
          },
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
      });

    const createInvite = (email: string, createdBy: string) => invites.create(email, createdBy);
    const revokeInvite = (inviteId: string) => invites.revoke(inviteId);
    const listInvites = () => invites.list();
    const issuePasswordLink = (userId: string) => passwordLinks.issue(userId);

    return { listMembers, setActive, removeUser, createInvite, revokeInvite, listInvites, issuePasswordLink };
  }),
}) {}
