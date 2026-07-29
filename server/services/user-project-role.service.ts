import { Effect, Data } from "effect";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { UserRepo } from "../repos/user.repo";
import { ProjectRepo } from "../repos/project.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { UserNotFound } from "./user.service";

export class ProjectAccessDenied extends Data.TaggedError("ProjectAccessDenied")<{ project: string; role: string }> {}
export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{ identifier: string }> {}

export class UserProjectRoleService extends Effect.Service<UserProjectRoleService>()("Lexa/UserProjectRoleService", {
  dependencies: [UserProjectRoleRepo.Default, UserRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* UserProjectRoleRepo;
    const userRepo = yield* UserRepo;
    const projectRepo = yield* ProjectRepo;

    const authorizeProject = (userId: string, projectSlug: string): Effect.Effect<{ userId: string; projectId: string; role: string }, DbError | RowNotFound | ProjectAccessDenied> =>
      Effect.gen(function* () {
        const user = yield* userRepo.findById(userId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new RowNotFound({ table: "users" })))
        );
        const project = yield* projectRepo.findBySlug(projectSlug);

        if (user.role === "admin") return { userId: user.id, projectId: project.id, role: "admin" };

        const mapping = yield* repo.findByUserAndProject(userId, project.id);
        if (!mapping) return yield* Effect.fail(new ProjectAccessDenied({ project: projectSlug, role: user.role }));
        return { userId: user.id, projectId: project.id, role: mapping.role };
      });

    const listForUser = (userId: string): Effect.Effect<UserProjectRoleRow[], DbError> =>
      repo.findByUserId(userId);

    const listForProject = (projectId: string): Effect.Effect<UserProjectRoleRow[], DbError> =>
      repo.findByProjectId(projectId);

    const setRole = (userId: string, projectId: string, role: "admin" | "member"): Effect.Effect<void, DbError | UserNotFound | ProjectNotFound | ConstraintViolation> =>
      Effect.gen(function* () {
        yield* userRepo.findById(userId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new UserNotFound({ id: userId })))
        );
        yield* projectRepo.findById(projectId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.fail(new ProjectNotFound({ identifier: projectId })))
        );
        yield* repo.setRole(userId, projectId, role);
      });

    const removeAccess = (userId: string, projectId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
      repo.removeAccess(userId, projectId);

    return { authorizeProject, listForUser, listForProject, setRole, removeAccess };
  }),
}) {}
