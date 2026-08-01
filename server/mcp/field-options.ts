import { Effect } from "effect";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { DbError } from "../db/database";
import type { FieldOption } from "../../shared/types";

// Resolve a priority/type LABEL (case-insensitive) to its option id.
// Falls back to the first option (create default) when omitted.
// Returns null when the label matches nothing → caller surfaces INVALID_OPTION
// with available* choices.
export function resolveFieldOptionId(
  projectId: string,
  kind: "priority" | "type",
  label?: string
): Effect.Effect<{ id: string; label: string } | null, DbError, FieldConfigRepo> {
  return Effect.gen(function* () {
    const repo = yield* FieldConfigRepo;
    const options = kind === "priority"
      ? yield* repo.findPrioritiesByProject(projectId)
      : yield* repo.findTypesByProject(projectId);
    if (label === undefined || label === "") {
      const first = options[0];
      return first ? { id: first.id, label: first.label } : null;
    }
    const wanted = label.trim().toLowerCase();
    const match = options.find((o) => o.label.toLowerCase() === wanted);
    return match ? { id: match.id, label: match.label } : null;
  });
}

export function optionLabel(options: FieldOption[], id: string): string {
  return options.find((o) => o.id === id)?.label ?? id;
}
