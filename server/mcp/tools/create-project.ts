import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";
import { ProjectReposRepo } from "../../repos/project-repos.repo";

export const tool = {
  name: "create_project",
  description: "Create a new project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project name" },
      slug: { type: "string", description: "Optional URL-friendly slug (auto-generated from name if omitted)" },
      description: { type: "string", description: "Project description" },
    },
    required: ["name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const reposRepo = yield* ProjectReposRepo;
      const project = yield* service.create({
        name: args.name,
        slug: args.slug,
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
