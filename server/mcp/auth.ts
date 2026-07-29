import { Effect } from "effect";
import { UserRepo } from "../repos/user.repo";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { ProjectRepo } from "../repos/project.repo";
import { Forbidden } from "../api/errors";

export function checkProjectAccess(userId: string | null, role: string, projectSlug: string) {
  return Effect.gen(function* () {
    if (role === "admin") return;
    if (!userId) return yield* new Forbidden({ message: "API key not linked to a user" });
    const userRepo = yield* UserRepo;
    const user = yield* userRepo.findById(userId).pipe(
      Effect.catchTag("RowNotFound", () => new Forbidden({ message: "User not found" }))
    );
    if (user.role === "admin") return;
    const projectRepo = yield* ProjectRepo;
    const projectRoleRepo = yield* UserProjectRoleRepo;
    const project = yield* projectRepo.findBySlug(projectSlug).pipe(
      Effect.catchTag("RowNotFound", () => new Forbidden({ message: `Project '${projectSlug}' not found` }))
    );
    const mapping = yield* projectRoleRepo.findByUserAndProject(userId, project.id);
    if (!mapping) return yield* new Forbidden({ message: `Access denied to project '${projectSlug}'` });
  });
}
