import { Effect, Data } from "effect";
import { UserRepo } from "../repos/user.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { UserRow } from "../../shared/db";

export class UserNotFound extends Data.TaggedError("UserNotFound")<{ id: string }> {}
export class CannotDeleteSelf extends Data.TaggedError("CannotDeleteSelf")<{}> {}
export class LastAdminDemote extends Data.TaggedError("LastAdminDemote")<{}> {}

export class UserService extends Effect.Service<UserService>()("Lexa/UserService", {
  dependencies: [UserRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* UserRepo;
    const cannotDeleteSelf: Effect.Effect<never, CannotDeleteSelf> = Effect.fail(new CannotDeleteSelf());

    return {
      list: (): Effect.Effect<UserRow[], DbError> => repo.listAll(),

      getById: (id: string): Effect.Effect<UserRow, DbError | UserNotFound> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
        ),

      promoteToAdmin: (id: string): Effect.Effect<void, DbError | RowNotFound | UserNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
          );
          yield* repo.updateRole(id, "admin");
        }),

      demoteToMember: (id: string, currentUserId: string): Effect.Effect<void, DbError | RowNotFound | UserNotFound | ConstraintViolation | CannotDeleteSelf | LastAdminDemote> =>
        Effect.gen(function* () {
          if (id === currentUserId) {
            yield* cannotDeleteSelf;
            return;
          }
          const target = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id })))
          );
          if (target.role !== "admin") return; // demoting a member is an idempotent no-op
          const changed = yield* repo.demoteIfNotLastAdmin(id);
          if (changed === 0) {
            return yield* new LastAdminDemote();
          }
        }),
    };
  }),
}) {}
