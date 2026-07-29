import { Effect, Data } from "effect";
import { UserRepo } from "../repos/user.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { UserRow } from "../../shared/types";

export class UserNotFound extends Data.TaggedError("UserNotFound")<{ id: string }> {}
export class CannotDeleteSelf extends Data.TaggedError("CannotDeleteSelf")<{}> {}

export class UserService extends Effect.Service<UserService>()("Lexa/UserService", {
  dependencies: [UserRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* UserRepo;

    return {
      list: (): Effect.Effect<UserRow[], DbError> => repo.listAll(),

      getById: (id: string): Effect.Effect<UserRow, DbError | UserNotFound> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
        ),

      promoteToAdmin: (id: string): Effect.Effect<void, DbError | UserNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
          );
          yield* repo.updateRole(id, "admin");
        }),

      demoteToMember: (id: string, currentUserId: string): Effect.Effect<void, DbError | UserNotFound | ConstraintViolation | CannotDeleteSelf> =>
        Effect.gen(function* () {
          if (id === currentUserId) return yield* Effect.fail(new CannotDeleteSelf({}));
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
          );
          yield* repo.updateRole(id, "member");
        }),
    };
  }),
}) {}
