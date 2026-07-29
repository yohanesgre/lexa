import { Effect } from "effect";
import { UserService } from "../../services/user.service";
import { UserProjectRoleService } from "../../services/user-project-role.service";
import { ProjectRepo } from "../../repos/project.repo";

export const tool = {
  name: "list_user_project_roles",
  description: "List project access grants for a user. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID" },
    },
    required: ["userId"],
  },
  handler: (args: { userId: string }, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const userService = yield* UserService;
      const roleService = yield* UserProjectRoleService;
      const projectRepo = yield* ProjectRepo;
      yield* userService.getById(args.userId);
      const roles = yield* roleService.listForUser(args.userId);
      const data = [];
      for (const r of roles) {
        const project = yield* projectRepo.findById(r.project_id);
        data.push({ projectId: r.project_id, projectSlug: project.slug, role: r.role });
      }
      return { data };
    }),
};
