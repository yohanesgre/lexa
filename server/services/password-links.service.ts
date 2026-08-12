import { Effect, Data } from "effect";
import { randomBytes } from "node:crypto";
import { Sqlite, DbError, RowNotFound } from "../db/database";
import { PUBLIC_URL } from "../auth";

export class PasswordLinkIssueFailed extends Data.TaggedError("PasswordLinkIssueFailed")<{ message: string }> {}

// Admin-issued set-password links (R11): a verification row with the native
// `reset-password:<token>` identifier, single-use + expiry enforced by
// better-auth's consumeVerificationValue (POST /api/auth/reset-password —
// keyless by design). No email transport — the link is shared out-of-band.
export class PasswordLinksService extends Effect.Service<PasswordLinksService>()("Lexa/PasswordLinksService", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const issue = (userId: string): Effect.Effect<{ token: string; link: string }, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const user = yield* Effect.try({
          try: () => db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as { id: string } | null,
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        if (!user) return yield* Effect.fail(new RowNotFound({ table: "users" }));
        const token = randomBytes(18).toString("base64url");
        const now = Date.now();
        const expiresAt = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
        yield* Effect.try({
          try: () =>
            db
              .prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
              .run(randomBytes(16).toString("base64url"), `reset-password:${token}`, userId, expiresAt, new Date(now).toISOString(), new Date(now).toISOString()),
          catch: (e) => new DbError({ message: String(e), cause: e }),
        });
        return { token, link: `${PUBLIC_URL}/set-password?token=${token}` };
      });

    return { issue };
  }),
}) {}
