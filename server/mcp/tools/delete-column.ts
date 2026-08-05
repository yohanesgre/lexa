import { Effect } from "effect";
import { ColumnService } from "../../services/column.service";
import { resolveProject } from "../resolve";
import { ColumnNotFound, HasChildren } from "../../api/errors";

export const tool = {
  name: "delete_column",
  description: "Delete a column. Column must be empty (no tasks). Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      column: { type: "string", description: "Column name (case-insensitive)" },
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

      const deleteResult = yield* Effect.either(columnService.delete(column.id));
      if (deleteResult._tag === "Left") {
        const e = deleteResult.left;
        if (e._tag === "HasChildren") {
          const hc = e as HasChildren;
          return { isError: true, error: { code: "HAS_CHILDREN", message: `Column has ${hc.count} tasks — move them first` } };
        }
        return yield* Effect.fail(e);
      }

      return { deleted: true };
    }),
};
