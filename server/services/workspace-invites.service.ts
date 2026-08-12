import { Effect, Data } from "effect";
import { randomUUID } from "node:crypto";
import { Sqlite, DbError, ConstraintViolation, RowNotFound } from "../db/database";
import { PUBLIC_URL } from "../auth";
import type { WorkspaceInvite } from "../../shared/types";

export class InviteAlreadyPending extends Data.TaggedError("InviteAlreadyPending")<{ email: string }> {}
export class InviteNotFound extends Data.TaggedError("InviteNotFound")<{ inviteId: string }> {}

interface InviteRow {
  id: string;
  email: string;
  token: string;
  expires_at: string;
  accepted_at: string | null;
}

const toInvite = (row: InviteRow): WorkspaceInvite => ({
  id: row.id,
  email: row.email,
  tokenHint: row.token.slice(0, 8),
  expiresAt: row.expires_at,
  acceptedAt: row.accepted_at,
});

// Superadmin-issued app-member invites (R3/R6): link-based, 7d expiry,
// revocable while pending. Acceptance lives on the auth surface
// (POST /api/auth/invite/accept, server/auth.ts) — the token is the auth.
export class WorkspaceInvitesService extends Effect.Service<WorkspaceInvitesService>()("Lexa/WorkspaceInvitesService", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const create = (email: string, createdBy: string | null): Effect.Effect<{ invite: WorkspaceInvite; link: string }, InviteAlreadyPending | ConstraintViolation | DbError> =>
      Effect.gen(function* () {
        const token = randomUUID();
        const id = randomUUID();
        const normalized = email.trim().toLowerCase();
        const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        // L1: an EXPIRED invite must not block re-issue (UNIQUE email) — the
        // spec allows re-inviting; drop the dead row first. Accepted invites
        // are kept (audit) and still block (the user exists already).
        // expires_at is stored ISO-8601 — compare against an ISO now, not
        // datetime('now') (mixed formats mis-compare: 'T' > ' ').
        yield* Effect.try({
          try: () => db.prepare("DELETE FROM workspace_invitations WHERE email = ? AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run(normalized),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        yield* Effect.try({
          try: () =>
            db
              .prepare("INSERT INTO workspace_invitations (id, email, role, token, expires_at, created_by) VALUES (?, ?, 'member', ?, ?, ?)")
              .run(id, normalized, token, expiresAt, createdBy),
          catch: (e) => {
            const msg = String(e);
            if (msg.includes("UNIQUE") || /constraint failed/i.test(msg)) {
              return new InviteAlreadyPending({ email: normalized });
            }
            return new DbError({ message: msg, cause: e });
          },
        });
        return {
          invite: toInvite({ id, email: normalized, token, expires_at: expiresAt, accepted_at: null }),
          link: `${PUBLIC_URL}/invite?token=${token}`,
        };
      });

    const revoke = (id: string): Effect.Effect<void, InviteNotFound | ConstraintViolation | DbError> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () => db.prepare("SELECT accepted_at FROM workspace_invitations WHERE id = ?").get(id) as { accepted_at: string | null } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!row) return yield* Effect.fail(new InviteNotFound({ inviteId: id }));
        if (row.accepted_at) {
          // Accepted invites are spent — the member account exists. Revoking
          // the link is meaningless; surface 409 (contract: pending only).
          return yield* Effect.fail(new ConstraintViolation({ message: "invite already accepted", isPositionConflict: false }));
        }
        yield* Effect.try({
          try: () => db.prepare("DELETE FROM workspace_invitations WHERE id = ?").run(id),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
      });

    const list = (): Effect.Effect<WorkspaceInvite[], DbError> =>
      Effect.try({
        try: () =>
          (db.prepare("SELECT id, email, token, expires_at, accepted_at FROM workspace_invitations ORDER BY created_at DESC, rowid DESC").all() as InviteRow[]).map(toInvite),
        catch: (e) => new DbError({ message: String(e), cause: e }),
      });

    return { create, revoke, list };
  }),
}) {}
