import { Effect } from "effect";
import { ColumnService } from "../../services/column.service";
import { TaskService } from "../../services/task.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "get_project_status",
  description: "Get board health snapshot — task count per column and total tasks. Use before planning batch moves to check WIP headroom.",
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
      const taskService = yield* TaskService;

      const columns = yield* columnService.findByProject(project.id);
      const tasks = yield* taskService.findAllByProject(project.id);

      const countMap = new Map<string, number>();
      for (const t of tasks) {
        countMap.set(t.columnId, (countMap.get(t.columnId) ?? 0) + 1);
      }

      return {
        columns: columns.map((c) => ({
          name: c.name,
          count: countMap.get(c.id) ?? 0,
          wipLimit: c.wipLimit,
        })),
        totalTasks: tasks.length,
      };
    }),
};
