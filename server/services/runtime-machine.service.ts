import { Effect } from "effect";
import { RuntimeMachineRepo } from "../repos/runtime-machine.repo";
import { DbError, ConstraintViolation } from "../db/database";
import { MachineNotFound, MachineOffline } from "../api/errors";
import type { Machine } from "../../shared/types";

export class RuntimeMachineService extends Effect.Service<RuntimeMachineService>()("Lexa/RuntimeMachineService", {
  dependencies: [RuntimeMachineRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* RuntimeMachineRepo;

    const get = (id: string): Effect.Effect<Machine, MachineNotFound | DbError> =>
      repo.findById(id).pipe(
        Effect.catchTag("RowNotFound", () => new MachineNotFound({ id }))
      );

    return {
      heartbeat: (input: { id: string; hostname: string }): Effect.Effect<Machine, ConstraintViolation | DbError> =>
        repo.heartbeat(input),

      get,

      requireOnline: (id: string): Effect.Effect<Machine, MachineNotFound | MachineOffline | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* repo.markOffline();
          const machine = yield* get(id);
          if (!machine.lastSeen) {
            return yield* new MachineOffline({ id: machine.id, hostname: machine.hostname, lastSeen: null });
          }
          return machine;
        }),

      list: (): Effect.Effect<Machine[], ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.markOffline();
          return yield* repo.list();
        }),
    };
  }),
}) {}
