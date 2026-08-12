import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";
import { ProjectReposRepo } from "../../repos/project-repos.repo";

export const tool = {
  name: "update_project",
  description: "Update a project's name or description. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Project slug to update" },
      name: { type: "string", description: "New project name" },
      description: { type: "string", description: "New description" },
    },
    required: ["slug"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const reposRepo = yield* ProjectReposRepo;
      const project = yield* service.update(args.slug, {
        name: args.name,
        description: args.description,
      });
      const repos = yield* reposRepo.listByProject(project.id);
      return {
        name: project.name,
        slug: project.slug,
        description: project.description,
        repos,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    }),
};
