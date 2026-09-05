import { Effect, Data } from "effect";
import { randomBytes } from "node:crypto";
import { Db, ConstraintViolation, DbError, RowNotFound, queryFirst, run } from "../db/db";
import { PUBLIC_URL } from "../auth";

export class PasswordLinkIssueFailed extends Data.TaggedError("PasswordLinkIssueFailed")<{ message: string }> {}

// Admin-issued set-password links (R11): a verification row with the native
// `reset-password:<token>` identifier, single-use + expiry enforced by
// better-auth's consumeVerificationValue (POST /api/auth/reset-password —
// keyless by design). No email transport — the link is shared out-of-band.
export class PasswordLinksService extends Effect.Service<PasswordLinksService>()("Lexa/PasswordLinksService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const issue = (userId: string): Effect.Effect<{ token: string; link: string }, RowNotFound | DbError> =>
      Effect.gen(function* () {
        const user = yield* queryFirst<{ id: string }>(db, "SELECT id FROM users WHERE id = ?", userId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        );
        if (!user) return yield* Effect.fail(new RowNotFound({ table: "users" }));
        const token = randomBytes(18).toString("base64url");
        const now = Date.now();
        const expiresAt = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
        yield* run(
          db,
          "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
          randomBytes(16).toString("base64url"), `reset-password:${token}`, userId, expiresAt, new Date(now).toISOString(), new Date(now).toISOString()
        ).pipe(Effect.mapError((e) => (e instanceof ConstraintViolation ? new DbError({ message: e.message, cause: e }) : e)));
        return { token, link: `${PUBLIC_URL}/set-password?token=${token}` };
      });

    return { issue };
  }),
}) {}
