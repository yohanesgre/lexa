import { Effect } from "effect";
import { randomBytes } from "node:crypto";
import { RuntimeMachineRepo, type MachineCli } from "../repos/runtime-machine.repo";
import { ForgeRepo } from "../repos/forge.repo";
import { RuntimeEventService } from "./runtime-event.service";
import { DbError, ConstraintViolation, Sqlite, withTx } from "../db/database";
import { MachineIdTaken, MachineNotFound } from "../api/errors";
import type { Machine } from "../../shared/types";

// 43-char base62 secret (same algorithm as entry.ts generateRawKey, without
// the lxk_ prefix). Minted per machine at first registration; returned to the
// caller exactly once.
function generateMachineSecret(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0] + result;
  return result;
}

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
      register: (input: { id: string; hostname: string; secret: string }): Effect.Effect<
        { machine: Machine; secret: string | null },
        MachineIdTaken | ConstraintViolation | DbError
      > =>
        Effect.gen(function* () {
          const mintedSecret = generateMachineSecret();
          const result = yield* repo.register({ ...input, mintedSecret });
          if (result._tag === "conflict") {
            return yield* new MachineIdTaken({ id: input.id, reason: result.reason });
          }
          return result._tag === "created"
            ? { machine: result.machine, secret: mintedSecret }
            : { machine: result.machine, secret: null };
        }),

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
