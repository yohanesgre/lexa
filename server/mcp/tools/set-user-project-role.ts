import { Effect } from "effect";
import { UserService } from "../../services/user.service";
import { UserProjectRoleService } from "../../services/user-project-role.service";
import { ProjectRepo } from "../../repos/project.repo";

export const tool = {
  name: "set_user_project_role",
  description: "Grant project access to a user. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "User ID" },
      project: { type: "string", description: "Project slug" },
      role: { type: "string", enum: ["admin", "member"], description: "Project role" },
    },
    required: ["userId", "project", "role"],
  },
  handler: (args: { userId: string; project: string; role: "admin" | "member" }, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const userService = yield* UserService;
      const roleService = yield* UserProjectRoleService;
      const projectRepo = yield* ProjectRepo;
      yield* userService.getById(args.userId);
      const project = yield* projectRepo.findBySlug(args.project);
      yield* roleService.setRole(args.userId, project.id, args.role);
      return { userId: args.userId, projectSlug: project.slug, role: args.role };
    }),
};
