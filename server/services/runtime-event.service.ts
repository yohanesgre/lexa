import { Effect } from "effect";
import { RuntimeEventRepo, storeRawKey, takeRawKey } from "../repos/runtime-event.repo";
import { RuntimeMachineRepo } from "../repos/runtime-machine.repo";
import { ApiKeyRepo } from "../repos/api-key.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ApiKeyNotFound, MachineNotFound, MachineSecretMismatch, RuntimeEventNotFound } from "../api/errors";
import { constantTimeTokenEqual } from "../api/auth-key";
import type { HearthProvider, RuntimeEvent, RuntimeEventAction } from "../../shared/types";

export class RuntimeEventService extends Effect.Service<RuntimeEventService>()("Lexa/RuntimeEventService", {
  dependencies: [RuntimeEventRepo.Default, RuntimeMachineRepo.Default, ApiKeyRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* RuntimeEventRepo;
    const machineRepo = yield* RuntimeMachineRepo;
    const apiKeyRepo = yield* ApiKeyRepo;

    const createRow = (input: {
      machineId: string;
      action: RuntimeEventAction;
      agentCli: HearthProvider;
      apiKeyId: string | null;
    }): Effect.Effect<RuntimeEvent, ConstraintViolation | DbError> =>
      repo.create({ id: crypto.randomUUID(), ...input });

    return {
      create: (input: {
        machineId: string;
        action: "install" | "update";
        agentCli: HearthProvider;
        apiKeyId?: string;
        rawKey?: string;
      }): Effect.Effect<RuntimeEvent, MachineNotFound | ApiKeyNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* machineRepo.findById(input.machineId).pipe(
            Effect.catchTag("RowNotFound", () => new MachineNotFound({ id: input.machineId }))
          );

          let apiKeyId: string | null = null;
          if (input.action === "install") {
            const apiKeyIdInput = input.apiKeyId;
            const rawKey = input.rawKey;
            if (!apiKeyIdInput || !rawKey) {
              return yield* new ApiKeyNotFound({ id: apiKeyIdInput ?? "" });
            }
            const hash = yield* Effect.promise(() => sha256(rawKey));
            const key = yield* apiKeyRepo.findByHash(hash).pipe(
              Effect.catchTag("RowNotFound", () => new ApiKeyNotFound({ id: apiKeyIdInput }))
            );
            if (key.id !== apiKeyIdInput) {
              return yield* new ApiKeyNotFound({ id: apiKeyIdInput });
            }
            apiKeyId = apiKeyIdInput;
          }

          const event = yield* createRow({
            machineId: input.machineId,
            action: input.action,
            agentCli: input.agentCli,
            apiKeyId,
          });
          if (input.action === "install" && input.rawKey) storeRawKey(event.id, input.rawKey);
          return event;
        }),

      createRemove: (input: { machineId: string; agentCli: HearthProvider }): Effect.Effect<RuntimeEvent, MachineNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* machineRepo.findById(input.machineId).pipe(
            Effect.catchTag("RowNotFound", () => new MachineNotFound({ id: input.machineId }))
          );
          return yield* createRow({ ...input, action: "remove", apiKeyId: null });
        }),

      claimForMachine: (machineId: string, secret: string): Effect.Effect<{ event: RuntimeEvent; rawKey: string | null } | null, MachineSecretMismatch | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          // Machine identity is client-chosen, so the claim surface is bound
          // to the per-machine secret. Missing row, legacy '' secret, and
          // mismatch all fail identically — no existence oracle.
          const stored = yield* machineRepo.findSecret(machineId).pipe(
            Effect.catchTag("RowNotFound", () => new MachineSecretMismatch())
          );
          if (stored === "" || !constantTimeTokenEqual(stored, secret)) {
            return yield* new MachineSecretMismatch();
          }
          const event = yield* repo.claimNextForMachine(machineId);
          if (!event) return null;
          return { event, rawKey: takeRawKey(event.id) };
        }),

      complete: (id: string): Effect.Effect<RuntimeEvent, RuntimeEventNotFound | ConstraintViolation | DbError> =>
        repo.complete(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeEventNotFound({ id }))
        ),

      fail: (id: string, error: string): Effect.Effect<RuntimeEvent, RuntimeEventNotFound | ConstraintViolation | DbError> =>
        repo.fail(id, error).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeEventNotFound({ id }))
        ),

      getById: (id: string): Effect.Effect<RuntimeEvent, RuntimeEventNotFound | DbError> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => new RuntimeEventNotFound({ id }))
        ),

      list: (machineId?: string): Effect.Effect<RuntimeEvent[], DbError> => repo.list(machineId),
    };
  }),
}) {}

function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  return crypto.subtle.digest("SHA-256", data).then((buf) =>
    Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}
