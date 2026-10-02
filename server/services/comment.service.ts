import { Effect } from "effect";
import { batchResults, requireRow, type BatchStmt, Db, DbError, ConstraintViolation, RowNotFound } from "../db/db";
import { CommentRepo } from "../repos/comment.repo";
import { ActivityRepo } from "../repos/activity.repo";
import { TaskRepo } from "../repos/task.repo";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { rowToComment, rowToActivityEvent, type CommentRow, type ActivityRow } from "../../shared/db";
import { TipTapDoc, Actor, TaskComment, ActivityEvent } from "../../shared/types";
import type { AuthIdentityShape } from "../api/auth";
import { TaskNotFound, CommentNotFound, CommentEditForbidden, CommentDeleteForbidden, CommentInvalid } from "../api/errors";
import { isEmptyDoc } from "./task.service";
import * as msg from "../activity-messages";

const MAX_COMMENT_BYTES = 65536;

export class CommentService extends Effect.Service<CommentService>()("Lexa/CommentService", {
  dependencies: [CommentRepo.Default, ActivityRepo.Default, TaskRepo.Default, UserProjectRoleRepo.Default],
  effect: Effect.gen(function* () {
    const commentRepo = yield* CommentRepo;
    const activityRepo = yield* ActivityRepo;
    const taskRepo = yield* TaskRepo;
    const roleRepo = yield* UserProjectRoleRepo;
    const db = yield* Db;

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

    const create = (taskId: string, actor: Actor, body: TipTapDoc, opts?: { viaAssistant?: boolean }): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, TaskNotFound | CommentInvalid | DbError | ConstraintViolation | RowNotFound> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        // Existence pre-check — a bare insert would surface a raw FK
        // ConstraintViolation; the domain error is TaskNotFound.
        yield* taskRepo.findById(taskId).pipe(
          Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
        );
        return yield* Effect.gen(function* () {
          const [commentRes, activityRes] = yield* batchResults(db, [
            commentRepo.insertStmt({
              taskId, authorId: actor.userId ?? null, authorKind: actor.kind,
              authorLabel: actor.label, body: JSON.stringify(body),
              viaAssistant: opts?.viaAssistant === true,
            }),
            activityRepo.insertStmt({
              taskId, actorKind: actor.kind, actorLabel: actor.label,
              actorUserId: actor.userId ?? null, type: "commented", message: msg.commented(actor.label),
              viaAssistant: opts?.viaAssistant === true,
            }),
          ]);
          const commentRow = yield* requireRow<CommentRow>(commentRes, "comment.create comment");
          const activityRow = yield* requireRow<ActivityRow>(activityRes, "comment.create activity");
          return {
            comment: rowToComment(commentRow),
            activity: rowToActivityEvent(activityRow),
          };
        });
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

    const edit = (commentId: number, identity: AuthIdentityShape, body: TipTapDoc, taskId: string): Effect.Effect<TaskComment, CommentNotFound | CommentEditForbidden | CommentInvalid | DbError | RowNotFound> =>
      Effect.gen(function* () {
        yield* validateBody(body);
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        if (comment.taskId !== taskId) return yield* new CommentNotFound({ id: commentId });
        if (comment.authorKind !== "user" || comment.authorId !== identity.userId) {
          return yield* new CommentEditForbidden({ id: commentId });
        }
        return yield* commentRepo.updateBody(commentId, JSON.stringify(body)).pipe(
          Effect.catchTag("RowNotFound", () => new CommentNotFound({ id: commentId }))
        );
      });

    const remove = (commentId: number, identity: AuthIdentityShape, projectId: string, taskId: string): Effect.Effect<{ comment: TaskComment; activity: ActivityEvent }, CommentNotFound | CommentDeleteForbidden | DbError | ConstraintViolation | RowNotFound> =>
      Effect.gen(function* () {
        const comment = yield* commentRepo.findById(commentId).pipe(
          Effect.flatMap((c) => c ? Effect.succeed(c) : Effect.fail(new CommentNotFound({ id: commentId })))
        );
        if (comment.taskId !== taskId) return yield* new CommentNotFound({ id: commentId });
        const admin = yield* isProjectAdmin(identity, projectId);
        const author = comment.authorKind === "user" && comment.authorId === identity.userId;
        if (!author && !admin) return yield* new CommentDeleteForbidden({ id: commentId });
        // Activity first, conditional on a live row, then the soft-delete.
        // Expressing the guard in SQL (not a JS branch) keeps the batch
        // fixed-array while still emitting no orphan activity for a row that
        // another writer deleted between the pre-read and this batch.
        const activityStmt: BatchStmt = {
          sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
                SELECT ?, ?, ?, ?, ?, ?, 0
                WHERE EXISTS (SELECT 1 FROM task_comments WHERE id = ? AND deleted_at IS NULL)
                RETURNING id, task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant, created_at`,
          params: [
            comment.taskId,
            identity.userId ? "user" : "agent",
            identity.userName ?? "unknown",
            identity.userId,
            "comment_deleted",
            msg.commentDeleted(identity.userName ?? "unknown"),
            commentId,
          ],
        };
        const [activityRes, deleteRes] = yield* batchResults(db, [
          activityStmt,
          commentRepo.softDeleteStmt(commentId),
        ]);
        const deletedRow = yield* requireRow<CommentRow>(deleteRes, "comment.remove comment").pipe(
          Effect.catchTag("DbError", () => Effect.fail(new CommentNotFound({ id: commentId }))),
        );
        const activityRow = yield* requireRow<ActivityRow>(activityRes, "comment.remove activity");
        return {
          comment: rowToComment(deletedRow),
          activity: rowToActivityEvent(activityRow),
        };
      });

    return { create, edit, remove, isProjectAdmin };
  }),
}) {}
