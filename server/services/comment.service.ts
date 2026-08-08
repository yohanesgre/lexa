import { Effect, Data } from "effect";
import { withTx, Sqlite, DbError, ConstraintViolation, RowNotFound } from "../db/database";
import { CommentRepo } from "../repos/comment.repo";
import { ActivityRepo } from "../repos/activity.repo";
import { TaskRepo } from "../repos/task.repo";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { TipTapDoc, Actor, TaskComment, ActivityEvent } from "../../shared/types";
import type { AuthIdentityShape } from "../api/auth";
import { TaskNotFound } from "../api/errors";
import { isEmptyDoc } from "./task.service";
import * as msg from "../activity-messages";

export class CommentNotFound extends Data.TaggedError("CommentNotFound")<{ id: number }> {}
export class CommentEditForbidden extends Data.TaggedError("CommentEditForbidden")<{ id: number }> {}
export class CommentDeleteForbidden extends Data.TaggedError("CommentDeleteForbidden")<{ id: number }> {}
export class CommentInvalid extends Data.TaggedError("CommentInvalid")<{ reason: string }> {}
const MAX_COMMENT_BYTES = 65536;

export class CommentService extends Effect.Service<CommentService>()("Lexa/CommentService", {
  dependencies: [CommentRepo.Default, ActivityRepo.Default, TaskRepo.Default, UserProjectRoleRepo.Default],
  effect: Effect.gen(function* () {
    const commentRepo = yield* CommentRepo;
    const activityRepo = yield* ActivityRepo;
    const taskRepo = yield* TaskRepo;
    const roleRepo = yield* UserProjectRoleRepo;
    const db = yield* Sqlite;

    const validateBody = (body: TipTapDoc): Effect.Effect<void, CommentInvalid> =>
      Effect.gen(function* () {
        if (!body || typeof body !== "object" || body.type !== "doc") {
          return yield* new CommentInvalid({ reason: "body must be a TipTap doc" });
        }
        if (isEmptyDoc(body)) return yield* new CommentInvalid({ reason: "comment body is empty" });
        if (JSON.stringify(body).length > MAX_COMMENT_BYTES) {
          return yield* new CommentInvalid({ reason: "comment body exceeds 64KB" });
        }
      });

    const create = (taskId: string, actor: Actor, body: TipTapDoc): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, TaskNotFound | CommentInvalid | DbError | ConstraintViolation | RowNotFound> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        // Existence pre-check — a bare insert would surface a raw FK
        // ConstraintViolation; the domain error is TaskNotFound.
        yield* taskRepo.findById(taskId).pipe(
          Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
        );
        return yield* withTx(db, Effect.gen(function* () {
          const comment = yield* commentRepo.insert({
            taskId, authorId: actor.userId ?? null, authorKind: actor.kind,
            authorLabel: actor.label, body: JSON.stringify(body),
          });
          const activity = yield* activityRepo.insert({
            taskId, actorKind: actor.kind, actorLabel: actor.label,
            actorUserId: actor.userId ?? null, type: "commented", message: msg.commented(actor.label),
          });
          return { comment, activity };
        }));
      });

    const isProjectAdmin = (identity: AuthIdentityShape, projectId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (identity.role === "admin") return true;
        if (!identity.userId) return false;
        const mapping = yield* roleRepo.findByUserAndProject(identity.userId, projectId).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        );
        return mapping?.role === "admin";
      });

    const edit = (commentId: number, identity: AuthIdentityShape, body: TipTapDoc): Effect.Effect<TaskComment, CommentNotFound | CommentEditForbidden | CommentInvalid | DbError | RowNotFound> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        if (comment.authorKind !== "user" || comment.authorId !== identity.userId) {
          return yield* new CommentEditForbidden({ id: commentId });
        }
        return yield* commentRepo.updateBody(commentId, JSON.stringify(body)).pipe(
          Effect.catchTag("RowNotFound", () => new CommentNotFound({ id: commentId }))
        );
      });

    const remove = (commentId: number, identity: AuthIdentityShape, projectId: string): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, CommentNotFound | CommentDeleteForbidden | DbError | ConstraintViolation | RowNotFound> =>
      Effect.gen(function* () {
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        const admin = yield* isProjectAdmin(identity, projectId);
        const author = comment.authorKind === "user" && comment.authorId === identity.userId;
        if (!author && !admin) return yield* new CommentDeleteForbidden({ id: commentId });
        return yield* withTx(db, Effect.gen(function* () {
          const removed = yield* commentRepo.softDelete(commentId).pipe(
            Effect.catchTag("RowNotFound", () => new CommentNotFound({ id: commentId }))
          );
          const activity = yield* activityRepo.insert({
            taskId: removed.taskId, actorKind: identity.userId ? "user" : "agent",
            actorLabel: identity.userName ?? "unknown", actorUserId: identity.userId,
            type: "comment_deleted", message: msg.commentDeleted(identity.userName ?? "unknown"),
          });
          return { comment: removed, activity };
        }));
      });

    return { create, edit, remove, isProjectAdmin };
  }),
}) {}
