import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";

export const tool = {
  name: "update_project",
  description: "Update a project's name, description, or GitHub repo. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Project slug to update" },
      name: { type: "string", description: "New project name" },
      description: { type: "string", description: "New description" },
      githubRepo: { type: "string", description: "New GitHub repo (owner/name)" },
    },
    required: ["slug"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const project = yield* service.update(args.slug, {
        name: args.name,
        description: args.description,
        githubRepo: args.githubRepo,
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
