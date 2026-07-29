import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";
import { TaskService } from "../../services/task.service";

export const tool = {
  name: "list_projects",
  description: "List all projects with task counts.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: (_args: any) =>
    Effect.gen(function* () {
      const projectService = yield* ProjectService;
      const taskService = yield* TaskService;
      const projects = yield* projectService.list();

      const results = [];
      for (const project of projects) {
        const tasks = yield* taskService.findAllByProject(project.id);
        results.push({
          name: project.name,
          slug: project.slug,
          description: project.description,
          taskCount: tasks.length,
        });
      }

      return { projects: results };
    }),
};
