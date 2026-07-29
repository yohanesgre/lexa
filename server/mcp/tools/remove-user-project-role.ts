import { Effect } from "effect";
import { UserProjectRoleService } from "../../services/user-project-role.service";
import { ProjectRepo } from "../../repos/project.repo";

export const tool = {
  name: "remove_user_project_role",
  description: "Revoke a user's access to a project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID" },
      project: { type: "string", description: "Project slug" },
    },
    required: ["userId", "project"],
  },
  handler: (args: { userId: string; project: string }, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const roleService = yield* UserProjectRoleService;
      const projectRepo = yield* ProjectRepo;
      const project = yield* projectRepo.findBySlug(args.project);
      yield* roleService.removeAccess(args.userId, project.id);
      return { removed: true };
    }),
};
