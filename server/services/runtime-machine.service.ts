import { Effect } from "effect";
import { RuntimeMachineRepo, type MachineCli } from "../repos/runtime-machine.repo";
import { ForgeRepo } from "../repos/forge.repo";
import { RuntimeEventService } from "./runtime-event.service";
import { DbError, ConstraintViolation, Sqlite, withTx } from "../db/database";
import { MachineNotFound } from "../api/errors";
import type { Machine } from "../../shared/types";

export class RuntimeMachineService extends Effect.Service<RuntimeMachineService>()("Lexa/RuntimeMachineService", {
  dependencies: [RuntimeMachineRepo.Default, ForgeRepo.Default, RuntimeEventService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* RuntimeMachineRepo;
    const forgeRepo = yield* ForgeRepo;
    const eventService = yield* RuntimeEventService;
    const db = yield* Sqlite;

    const get = (id: string): Effect.Effect<Machine, MachineNotFound | DbError> =>
      repo.findById(id).pipe(
        Effect.catchTag("RowNotFound", () => new MachineNotFound({ id }))
      );

    return {
      register: (input: { id: string; hostname: string }): Effect.Effect<Machine, ConstraintViolation | DbError> =>
        repo.register(input),

      heartbeat: (input: { id: string; hostname: string; clis?: MachineCli[] }): Effect.Effect<Machine, ConstraintViolation | DbError> =>
        repo.heartbeat(input),

      get,

      list: (): Effect.Effect<Machine[], ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* repo.markOffline();
          return yield* repo.list();
        }),

      // Removes the host: queue machine-scoped remove events for each of its
      // runtimes (delivered whenever the listener next heartbeats — never
      // blocks), delete the runtime rows, then the machine. Pending setup
      // events cascade with the machine row (FK ON DELETE CASCADE). One tx —
      // a crash can't leave queued events for deleted runtimes.
      delete: (id: string): Effect.Effect<void, MachineNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* get(id);
          yield* withTx(
            db,
            Effect.gen(function* () {
              const runtimes = yield* forgeRepo.listRuntimesByMachine(id);
              for (const runtime of runtimes) {
                yield* eventService.createRemove({ machineId: id, agentCli: runtime.provider });
              }
              yield* forgeRepo.deleteRuntimesByMachine(id);
              yield* repo.delete(id).pipe(
                Effect.catchTag("RowNotFound", () => new MachineNotFound({ id }))
              );
            })
          );
        }),
    };
  }),
}) {}
