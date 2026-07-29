import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";

export const tool = {
  name: "create_project",
  description: "Create a new project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project name" },
      slug: { type: "string", description: "Optional URL-friendly slug (auto-generated from name if omitted)" },
      description: { type: "string", description: "Project description" },
      githubRepo: { type: "string", description: "GitHub repo (owner/name)" },
    },
    required: ["name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const project = yield* service.create({
        name: args.name,
        slug: args.slug,
        description: args.description,
        githubRepo: args.githubRepo ?? null,
      });
      return {
        name: project.name,
        slug: project.slug,
        description: project.description,
        githubRepo: project.githubRepo,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    }),
};
