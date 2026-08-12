import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";
import { ProjectReposRepo } from "../../repos/project-repos.repo";
import { TeamsService } from "../../services/teams.service";

// create_project: optional `team` (slug) assigns the project to that team.
// Unknown slug → error with details.availableTeams (exact names per API.md).
export const tool = {
  name: "create_project",
  description: "Create a new project. Admin only. Optional `team` (slug) assigns the project to that team.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project name" },
      slug: { type: "string", description: "Optional URL-friendly slug (auto-generated from name if omitted)" },
      description: { type: "string", description: "Project description" },
      team: { type: "string", description: "Optional team slug to assign the project to" },
    },
    required: ["name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || (auth.role !== "admin" && auth.role !== "superadmin")) {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const reposRepo = yield* ProjectReposRepo;
      let teamId: string | null = null;
      if (args.team) {
        const teams = yield* TeamsService;
        const team = yield* teams.findById(args.team as string);
        if (!team) {
          const available = yield* teams.listAll().pipe(Effect.map((ts) => ts.map((t) => t.slug)));
          return {
            isError: true,
            error: {
              code: "INVALID_TEAM",
              message: `Unknown team '${args.team}' — use one of: ${available.join(", ") || "(no teams yet)"}`,
              details: { team: args.team, availableTeams: available },
            },
          };
        }
        teamId = team.id;
      }
      const project = yield* service.create({
        name: args.name,
        slug: args.slug,
        description: args.description,
        teamId,
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
