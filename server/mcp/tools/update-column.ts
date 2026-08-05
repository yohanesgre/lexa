import { Effect } from "effect";
import { ColumnService } from "../../services/column.service";
import { resolveProject } from "../resolve";
import { ColumnNotFound } from "../../api/errors";

export const tool = {
  name: "update_column",
  description: "Update a column's name, WIP limit, required fields, color, or GitHub state. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      column: { type: "string", description: "Column name (case-insensitive)" },
      name: { type: "string", description: "New name" },
      color: { type: "string", description: "New color" },
      wipLimit: { type: "number", description: "New WIP limit (null to remove)" },
      requiredFields: { type: "array", items: { type: "string" }, description: "New required fields" },
      githubState: { type: "string", enum: ["open", "closed"], description: "New GitHub state" },
    },
    required: ["project", "column"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      if (typeof args.column !== "string" || args.column === "") {
        return { isError: true, error: { code: "INVALID_ARGS", message: "column is required" } };
      }

      const project = yield* resolveProject(args.project);
      const columnService = yield* ColumnService;

      const columns = yield* columnService.findByProject(project.id);
      const column = columns.find(
        (c) => c.name.toLowerCase() === args.column.toLowerCase()
      );

      if (!column) {
        return yield* new ColumnNotFound({
          id: args.column,
          availableColumns: columns.map((c) => c.name),
        } as any);
      }

      const updated = yield* columnService.update(column.id, {
        name: args.name,
        color: args.color,
        wipLimit: args.wipLimit,
        requiredFields: args.requiredFields,
        githubState: args.githubState,
      });

      return {
        id: updated.id,
        name: updated.name,
        wipLimit: updated.wipLimit,
        requiredFields: updated.requiredFields,
        githubState: updated.githubState,
        position: updated.position,
      };
    }),
};
