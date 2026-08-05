import { Effect } from "effect";
import { ColumnService } from "../../services/column.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "create_column",
  description: "Create a new column in a project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      name: { type: "string", description: "Column name" },
      color: { type: "string", description: "Hex color for column header" },
      wipLimit: { type: "number", description: "Max tasks in this column" },
      requiredFields: { type: "array", items: { type: "string" }, description: "Fields that must be filled before moving tasks here" },
      githubState: { type: "string", enum: ["open", "closed"], description: "GitHub issue state mapping" },
    },
    required: ["project", "name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      if (typeof args.name !== "string" || args.name === "") {
        return { isError: true, error: { code: "INVALID_ARGS", message: "name is required" } };
      }

      const project = yield* resolveProject(args.project);
      const columnService = yield* ColumnService;

      const column = yield* columnService.create({
        projectId: project.id,
        name: args.name,
        color: args.color,
        wipLimit: args.wipLimit,
        requiredFields: args.requiredFields,
        githubState: args.githubState,
      });

      return {
        id: column.id,
        name: column.name,
        wipLimit: column.wipLimit,
        requiredFields: column.requiredFields,
        githubState: column.githubState,
        position: column.position,
      };
    }),
};
