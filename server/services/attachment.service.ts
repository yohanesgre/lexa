import { Effect } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { Sqlite, withTx, DbError, ConstraintViolation } from "../db/database";
import { AttachmentRepo, AttachmentRow } from "../repos/attachment.repo";
import { ActivityService } from "./activity.service";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { UserRepo } from "../repos/user.repo";
import { WikiShareRepo } from "../repos/wiki-share.repo";
import { Storage, StorageConfig, storageKeyFor, KeyNotFound, StorageError } from "../storage/storage";
import { sniffMime, isInlineMime } from "../storage/mime";
import { Actor, ActivityEvent, Attachment } from "../../shared/types";
import {
  AttachmentNotFound,
  PayloadTooLarge,
  AttachmentDeleteForbidden,
  ShareLinkNotFound,
  InvalidArgs,
} from "../api/errors";
import type { AuthIdentityShape } from "../api/auth";
import * as msg from "../activity-messages";

export interface ServeAttachment {
  row: AttachmentRow;
  bytes: Uint8Array;
  inline: boolean;
}

// Basename (both separators), control chars stripped, trimmed, ≤255 chars.
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned.length <= 255 ? cleaned : cleaned.slice(0, 255);
}

export class AttachmentService extends Effect.Service<AttachmentService>()("Lexa/AttachmentService", {
  dependencies: [AttachmentRepo.Default, ActivityService.Default, UserProjectRoleRepo.Default, UserRepo.Default, WikiShareRepo.Default],
  effect: Effect.gen(function* () {
    const attachmentRepo = yield* AttachmentRepo;
    const activityService = yield* ActivityService;
    const roleRepo = yield* UserProjectRoleRepo;
    const userRepo = yield* UserRepo;
    const shareRepo = yield* WikiShareRepo;
    const storage = yield* Storage;
    const storageCfg = yield* StorageConfig;
    const db = yield* Sqlite;

    // Row → shared API shape; uploadedByLabel resolved server-side so the UI
    // shows a name without extra fetches.
    const toAttachment = (row: AttachmentRow): Effect.Effect<Attachment, DbError> =>
      Effect.gen(function* () {
        const label = row.uploaded_by
          ? yield* userRepo.findById(row.uploaded_by).pipe(
              Effect.map((u) => u.name),
              Effect.catchTag("RowNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() => Effect.succeed(null))
            )
          : null;
        return {
          id: row.id,
          projectId: row.project_id,
          taskId: row.task_id,
          wikiPageId: row.wiki_page_id,
          filename: row.filename,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
          uploadedBy: row.uploaded_by,
          uploadedByLabel: label,
          createdAt: row.created_at,
        };
      });

    const upload = (input: {
      projectId: string;
      taskId: string | null;
      wikiPageId: string | null;
      filename: string;
      bytes: Uint8Array;
      actor: Actor;
    }): Effect.Effect<{ attachment: Attachment; activity: ActivityEvent | null },
      PayloadTooLarge | InvalidArgs | StorageError | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        if ((input.taskId !== null) === (input.wikiPageId !== null)) {
          return yield* new InvalidArgs({ reason: "exactly one of taskId / wikiPageId is required" });
        }
        if (input.bytes.byteLength > storageCfg.maxUploadBytes) {
          return yield* new PayloadTooLarge({ size: input.bytes.byteLength, maxBytes: storageCfg.maxUploadBytes });
        }
        const sha256 = createHash("sha256").update(input.bytes).digest("hex");
        // Dedupe hit: the existing row is returned untouched — no blob
        // rewrite, no second activity row.
        const existing = yield* attachmentRepo.findByProjectAndSha(input.projectId, sha256);
        if (existing) {
          const attachment = yield* toAttachment(existing);
          return { attachment, activity: null };
        }

        const mimeType = sniffMime(input.bytes) ?? "application/octet-stream";
        const key = storageKeyFor(sha256);
        yield* storage.put(key, input.bytes);
        const filename = sanitizeFilename(input.filename);
        const id = randomUUID();
        return yield* withTx(db, Effect.gen(function* () {
          yield* attachmentRepo.insert({
            id,
            projectId: input.projectId,
            taskId: input.taskId,
            wikiPageId: input.wikiPageId,
            filename,
            mimeType,
            sizeBytes: input.bytes.byteLength,
            sha256,
            storageKey: key,
            uploadedBy: input.actor.userId ?? null,
          });
          let activity: ActivityEvent | null = null;
          if (input.taskId) {
            activity = yield* activityService.append(
              input.taskId,
              input.actor,
              "attachment_added",
              msg.attachmentAdded(input.actor.label, filename)
            );
          }
          const row = yield* attachmentRepo.findById(id).pipe(
            Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new DbError({ message: "attachment row vanished after insert" })))
          );
          const attachment = yield* toAttachment(row);
          return { attachment, activity };
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

    const remove = (attachmentId: string, identity: AuthIdentityShape): Effect.Effect<void,
      AttachmentNotFound | AttachmentDeleteForbidden | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = yield* attachmentRepo.findById(attachmentId).pipe(
          Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new AttachmentNotFound({ id: attachmentId })))
        );
        const admin = yield* isProjectAdmin(identity, row.project_id);
        const uploader = identity.userId !== null && row.uploaded_by === identity.userId;
        if (!uploader && !admin) {
          return yield* new AttachmentDeleteForbidden({ id: attachmentId });
        }
        yield* withTx(db, Effect.gen(function* () {
          yield* attachmentRepo.deleteById(attachmentId);
          if (row.task_id) {
            yield* activityService.append(
              row.task_id,
              { kind: identity.userId ? "user" : "agent", label: identity.userName ?? identity.keyName ?? "unknown", userId: identity.userId },
              "attachment_removed",
              msg.attachmentRemoved(identity.userName ?? identity.keyName ?? "unknown", row.filename)
            );
          }
        }));
        // Blob delete AFTER commit — only when this was the last referencing
        // row. Failure leaves an orphan blob (harmless by design).
        const remaining = yield* attachmentRepo.countByStorageKey(row.storage_key);
        if (remaining === 0) {
          yield* storage.delete(row.storage_key).pipe(
            Effect.catchAll(() => Effect.void)
          );
        }
      });

    const serve = (attachmentId: string): Effect.Effect<ServeAttachment, AttachmentNotFound | StorageError | DbError> =>
      Effect.gen(function* () {
        const row = yield* attachmentRepo.findById(attachmentId).pipe(
          Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new AttachmentNotFound({ id: attachmentId })))
        );
        const bytes = yield* storage.get(row.storage_key).pipe(
          Effect.catchTag("KeyNotFound", () => new AttachmentNotFound({ id: attachmentId }))
        );
        return { row, bytes, inline: isInlineMime(row.mime_type) };
      });

    // Token validated per request; only wiki-page attachments inside the
    // shared subtree are reachable — task attachments never surface here.
    const resolveShare = (token: string, attachmentId: string): Effect.Effect<ServeAttachment,
      ShareLinkNotFound | AttachmentNotFound | StorageError | DbError> =>
      Effect.gen(function* () {
        const link = yield* shareRepo.findByToken(token);
        if (!link || (link.expires_at !== null && link.expires_at <= new Date().toISOString())) {
          return yield* new ShareLinkNotFound();
        }
        const subtree = yield* shareRepo.findSubtreeRows(link.page_id);
        const ids = new Set(subtree.map((r) => r.id));
        const row = yield* attachmentRepo.findById(attachmentId).pipe(
          Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new AttachmentNotFound({ id: attachmentId })))
        );
        if (!row.wiki_page_id || !ids.has(row.wiki_page_id)) {
          return yield* new AttachmentNotFound({ id: attachmentId });
        }
        const bytes = yield* storage.get(row.storage_key).pipe(
          Effect.catchTag("KeyNotFound", () => new AttachmentNotFound({ id: attachmentId }))
        );
        return { row, bytes, inline: isInlineMime(row.mime_type) };
      });

    // Lists are project-guarded (rows filtered to the route's project) and
    // ordered created_at ASC, id ASC — stable oldest-first.
    const listForTask = (taskId: string, projectId: string): Effect.Effect<Attachment[], DbError> =>
      Effect.gen(function* () {
        const rows = yield* attachmentRepo.findByTaskId(taskId);
        return yield* Effect.all(rows.filter((r) => r.project_id === projectId).map(toAttachment));
      });

    const listForWikiPage = (wikiPageId: string, projectId: string): Effect.Effect<Attachment[], DbError> =>
      Effect.gen(function* () {
        const rows = yield* attachmentRepo.findByWikiPageId(wikiPageId);
        return yield* Effect.all(rows.filter((r) => r.project_id === projectId).map(toAttachment));
      });

    return { upload, remove, serve, resolveShare, listForTask, listForWikiPage };
  }),
}) {}

