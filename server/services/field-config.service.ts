import { Effect } from "effect";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ProjectRepo } from "../repos/project.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectNotFound, OptionInUse, InvalidOption } from "../api/errors";
import type { FieldConfig, FieldOption } from "../../shared/types";

export class FieldConfigService extends Effect.Service<FieldConfigService>()("Lexa/FieldConfigService", {
  dependencies: [FieldConfigRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* FieldConfigRepo;
    const projectRepo = yield* ProjectRepo;

    const getByProject = (projectId: string): Effect.Effect<FieldConfig, ProjectNotFound | DbError> =>
      Effect.gen(function* () {
        yield* projectRepo.findById(projectId).pipe(
          Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
        );
        return yield* repo.findByProject(projectId);
      });

    const replace = (
      projectId: string,
      input: { priorities: FieldOption[]; types: FieldOption[] }
    ): Effect.Effect<FieldConfig, ProjectNotFound | OptionInUse | InvalidOption | DbError | ConstraintViolation | RowNotFound> =>
      Effect.gen(function* () {
        yield* projectRepo.findById(projectId).pipe(
          Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
        );

        const validateList = (
          kind: "priority" | "type",
          options: FieldOption[]
        ): Effect.Effect<{ id: string; label: string; color: string; position: number }[], InvalidOption | OptionInUse | DbError> =>
          Effect.gen(function* () {
            if (options.length === 0) {
              return yield* new InvalidOption({ message: `${kind} list cannot be empty` });
            }
            const labels = new Set<string>();
            for (const o of options) {
              const label = o.label.trim();
              if (!label) {
                return yield* new InvalidOption({ message: `${kind} label cannot be empty` });
              }
              const lower = label.toLowerCase();
              if (labels.has(lower)) {
                return yield* new InvalidOption({ message: `duplicate ${kind} label '${label}'` });
              }
              labels.add(lower);
            }
            const existing = yield* repo.findByProject(projectId).pipe(
              Effect.map((c) => (kind === "priority" ? c.priorities : c.types))
            );
            const existingIds = new Set(existing.map((o) => o.id));
            for (const o of options) {
              if (o.id !== "" && o.id !== null && o.id !== undefined && !existingIds.has(o.id)) {
                return yield* new InvalidOption({ optionId: o.id, message: `unknown ${kind} option id` });
              }
            }
            // Deleting an option that tasks still use is blocked.
            const keptIds = new Set(options.flatMap((o) => (o.id ? [o.id] : [])));
            for (const old of existing) {
              if (!keptIds.has(old.id)) {
                const count = yield* repo.countTasksUsing(old.id, kind);
                if (count > 0) {
                  return yield* new OptionInUse({ optionId: old.id, label: old.label });
                }
              }
            }
            return options.map((o, i) => ({
              id: o.id && o.id !== "" ? o.id : crypto.randomUUID(),
              label: o.label.trim(),
              color: o.color || "#6b7280",
              position: i,
            }));
          });

        const [priorities, types] = yield* Effect.all([
          validateList("priority", input.priorities),
          validateList("type", input.types),
        ]);

        yield* Effect.all([
          repo.replaceList(projectId, "priority", priorities),
          repo.replaceList(projectId, "type", types),
        ]);
        yield* Effect.logInfo(`[FieldConfig] Replaced options for project ${projectId}`);
        return yield* repo.findByProject(projectId);
      });

    return {
      findByProject: getByProject,
      getByProject,
      replace,
    };
  }),
}) {}
