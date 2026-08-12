import { Effect } from "effect";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { ProjectRepo } from "../repos/project.repo";
import { Forbidden } from "../api/errors";

export function checkProjectAccess(userId: string | null, role: string, projectSlug: string) {
  return Effect.gen(function* () {
    // Keys are global (R15): unbound keys (role "admin") and superadmin-bound
    // keys pass everything. users.role is no longer consulted — roles live on
    // the key or the grant rows.
    if (role === "admin" || role === "superadmin") return;
    if (!userId) return yield* new Forbidden({ message: "API key not linked to a user" });
    const projectRepo = yield* ProjectRepo;
    const projectRoleRepo = yield* UserProjectRoleRepo;
    const project = yield* projectRepo.findBySlug(projectSlug).pipe(
      Effect.catchTag("RowNotFound", () => new Forbidden({ message: `Project '${projectSlug}' not found` }))
    );
    const mapping = yield* projectRoleRepo.findByUserAndProject(userId, project.id);
    if (!mapping) return yield* new Forbidden({ message: `Access denied to project '${projectSlug}'` });
  });
}
