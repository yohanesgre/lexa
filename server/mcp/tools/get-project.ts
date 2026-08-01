import { Effect } from "effect";
import { ColumnService } from "../../services/column.service";
import { SwimlaneService } from "../../services/swimlane.service";
import { FieldConfigService } from "../../services/field-config.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "get_project",
  description: "Get project details including columns (with WIP limits, required fields, GitHub state), swimlanes, and the field-config (priorities/types with labels+colors — use these LABELS when calling create_task/update_task/list_tasks).",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Project slug" },
    },
    required: ["slug"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.slug);
      const columnService = yield* ColumnService;
      const swimlaneService = yield* SwimlaneService;
      const fieldConfigService = yield* FieldConfigService;

      const columns = yield* columnService.findByProject(project.id);
      const swimlanes = yield* swimlaneService.findByProject(project.id);
      const config = yield* fieldConfigService.findByProject(project.id);

      return {
        name: project.name,
        slug: project.slug,
        description: project.description,
        githubRepo: project.githubRepo,
        columns: columns.map((c) => ({
          name: c.name,
          wipLimit: c.wipLimit,
          requiredFields: c.requiredFields,
          githubState: c.githubState,
        })),
        swimlanes: swimlanes.map((s) => ({ name: s.name })),
        priorities: config.priorities,
        types: config.types,
      };
    }),
};
