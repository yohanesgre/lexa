import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";
import { TaskService } from "../../services/task.service";
import { UserProjectRoleRepo } from "../../repos/user-project-role.repo";

export const tool = {
  name: "list_projects",
  description: "List all projects with task counts. Admins see all projects; members see only granted projects.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const projectService = yield* ProjectService;
      const taskService = yield* TaskService;
      const projects = yield* projectService.list();

      let visibleProjects = projects;
      if (auth && auth.role !== "admin") {
        if (!auth.userId) {
          return { projects: [] };
        }
        const roleRepo = yield* UserProjectRoleRepo;
        const mappings = yield* roleRepo.findByUserId(auth.userId);
        const allowedProjectIds = new Set(mappings.map((m) => m.project_id));
        visibleProjects = projects.filter((p) => allowedProjectIds.has(p.id));
      }

      const results = [];
      for (const project of visibleProjects) {
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
