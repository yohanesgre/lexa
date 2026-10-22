import { Effect } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { Db, batch, batchResults, requireRow, DbError, ConstraintViolation, type BatchStmt } from "../db/db";
import { AttachmentRepo, AttachmentRow } from "../repos/attachment.repo";
import { ChatAttachmentRepo, ChatAttachmentRow } from "../repos/chat-attachment.repo";
import { AssistantThreadRepo, type AssistantThread } from "../repos/assistant-thread.repo";
import { ActivityService } from "./activity.service";
import { rowToActivityEvent, type ActivityRow } from "../../shared/db";
import { UserProjectRoleRepo } from "../repos/user-project-role.repo";
import { UserRepo } from "../repos/user.repo";
import { WikiShareRepo } from "../repos/wiki-share.repo";
import { Storage, StorageConfig, storageKeyFor, KeyNotFound, StorageError } from "../storage/storage";
import { sniffMime, isInlineMime, resolveChatAttachmentMime } from "../storage/mime";
import { CHAT_ATTACHMENT_MAX_UPLOAD_BYTES } from "../storage/config";
import { chatAttachmentsEnabled } from "../capabilities";
import { currentEnv } from "../runtime-env";
import { Actor, ActivityEvent, Attachment } from "../../shared/types";
import {
  AttachmentNotFound,
  PayloadTooLarge,
  AttachmentDeleteForbidden,
  ChatAttachmentsDisabled,
  ShareLinkNotFound,
  AssistantThreadNotFound,
  InvalidArgs,
} from "../api/errors";
import type { AuthIdentityShape } from "../api/auth";
import * as msg from "../activity-messages";

export interface ServeAttachment {
  row: AttachmentRow;
  bytes: Uint8Array;
  inline: boolean;
}

// Chat attachments carry their own row shape (thread-scoped, no task/wiki ids).
export interface ServeChatAttachment {
  row: ChatAttachmentRow;
  bytes: Uint8Array;
  inline: boolean;
}

export interface ChatAttachmentView {
  id: string;
  projectId: string;
  chatId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string | null;
  uploadedByLabel: string | null;
  createdAt: string;
}

// Basename (both separators), control chars stripped, trimmed, ≤255 chars.
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned.length <= 255 ? cleaned : cleaned.slice(0, 255);
}

export class AttachmentService extends Effect.Service<AttachmentService>()("Lexa/AttachmentService", {
  dependencies: [AttachmentRepo.Default, ChatAttachmentRepo.Default, AssistantThreadRepo.Default, ActivityService.Default, UserProjectRoleRepo.Default, UserRepo.Default, WikiShareRepo.Default],
  effect: Effect.gen(function* () {
    const attachmentRepo = yield* AttachmentRepo;
    const chatRepo = yield* ChatAttachmentRepo;
    const threadRepo = yield* AssistantThreadRepo;
    const activityService = yield* ActivityService;
    const roleRepo = yield* UserProjectRoleRepo;
    const userRepo = yield* UserRepo;
    const shareRepo = yield* WikiShareRepo;
    const storage = yield* Storage;
    const storageCfg = yield* StorageConfig;
    const db = yield* Db;

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
        // One atomic batch: the deduped INSERT — a concurrent same-bytes upload
        // loses the UNIQUE(project_id, sha256) race quietly — plus the task
        // activity, gated on THIS attempted row existing so the loser never
        // emits a duplicate activity row. `RETURNING id` on the insert tells
        // the caller whether this upload won.
        const stmts: BatchStmt[] = [
          attachmentRepo.insertDedupeStmt({
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
          }),
        ];
        if (input.taskId) {
          stmts.push({
            sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
                  SELECT ?, ?, ?, ?, ?, ?, 0
                  WHERE EXISTS (SELECT 1 FROM attachments WHERE id = ?)
                  RETURNING id, task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant, created_at`,
            params: [input.taskId, input.actor.kind, input.actor.label, input.actor.userId ?? null, "attachment_added", msg.attachmentAdded(input.actor.label, filename), id],
          });
        }
        const results = yield* batchResults(db, stmts);
        const inserted = (results[0]?.results.length ?? 0) > 0;
        const row = inserted
          ? yield* attachmentRepo.findById(id).pipe(
              Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new DbError({ message: "attachment row vanished after insert" })))
            )
          : yield* attachmentRepo.findByProjectAndSha(input.projectId, sha256).pipe(
              Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new DbError({ message: "attachment dedupe row vanished after conflict" })))
            );
        const activity: ActivityEvent | null = inserted && input.taskId
          ? rowToActivityEvent(yield* requireRow<ActivityRow>(results[1], "attachment.upload activity"))
          : null;
        const attachment = yield* toAttachment(row);
        return { attachment, activity };
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
        yield* batch(db, [
          attachmentRepo.deleteByIdStmt(attachmentId),
          ...(row.task_id
            ? [activityService.appendStmt(
                row.task_id,
                { kind: identity.userId ? "user" : "agent", label: identity.userName ?? identity.keyName ?? "unknown", userId: identity.userId },
                "attachment_removed",
                msg.attachmentRemoved(identity.userName ?? identity.keyName ?? "unknown", row.filename)
              )]
            : []),
        ]);
        // Blob delete AFTER commit — only when this was the last referencing
        // row across BOTH tables (a blob may still back a chat attachment).
        // Failure leaves an orphan blob (harmless by design).
        yield* deleteBlobIfUnreferenced(row.storage_key);
      });

    const findAttachment = (attachmentId: string): Effect.Effect<AttachmentRow, AttachmentNotFound | DbError> =>
      attachmentRepo.findById(attachmentId).pipe(
        Effect.flatMap((row) => row ? Effect.succeed(row) : Effect.fail(new AttachmentNotFound({ id: attachmentId })))
      );

    const serve = (attachmentId: string): Effect.Effect<ServeAttachment, AttachmentNotFound | StorageError | DbError> =>
      Effect.gen(function* () {
        const row = yield* findAttachment(attachmentId);
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
        const list: Attachment[] = [];
        for (const row of rows) {
          if (row.project_id !== projectId) continue;
          list.push(yield* toAttachment(row));
        }
        return list;
      });

    const listForWikiPage = (wikiPageId: string, projectId: string): Effect.Effect<Attachment[], DbError> =>
      Effect.gen(function* () {
        const rows = yield* attachmentRepo.findByWikiPageId(wikiPageId);
        const list: Attachment[] = [];
        for (const row of rows) {
          if (row.project_id !== projectId) continue;
          list.push(yield* toAttachment(row));
        }
        return list;
      });

    // ── Chat attachments (thread-scoped conversation context) ──

    const toChatAttachment = (row: ChatAttachmentRow): Effect.Effect<ChatAttachmentView, DbError> =>
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
          chatId: row.document_id,
          filename: row.filename,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
          storageKey: row.storage_key,
          uploadedBy: row.uploaded_by,
          uploadedByLabel: label,
          createdAt: row.created_at,
        };
      });

    // Chat attachments are private to the authenticated thread owner. Missing
    // threads are tolerated for list, but only an authenticated user can claim
    // one during upload; the insert's conflict handling makes that claim atomic.
    const loadChatThread = (chatId: string): Effect.Effect<AssistantThread | null, DbError> =>
      threadRepo.loadThread("chat", chatId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));

    const requireChatOwner = (chatId: string, projectId: string, userId: string | null): Effect.Effect<void, AssistantThreadNotFound | DbError> =>
      Effect.gen(function* () {
        const thread = yield* loadChatThread(chatId);
        if (!userId || !thread || thread.ownerUserId !== userId || thread.projectId !== projectId) {
          return yield* new AssistantThreadNotFound({ documentType: "chat", documentId: chatId });
        }
      });

    const claimChatThread = (chatId: string, projectId: string, userId: string | null): Effect.Effect<void, AssistantThreadNotFound | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        if (!userId) return yield* new AssistantThreadNotFound({ documentType: "chat", documentId: chatId });
        yield* batch(db, [{
          sql: `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
                VALUES ('chat', ?, ?, ?, '[]')
                ON CONFLICT(document_type, document_id) DO NOTHING`,
          params: [chatId, projectId, userId],
        }]);
        yield* requireChatOwner(chatId, projectId, userId);
      });


    // Blob is shared across BOTH attachment tables — the last referencing row
    // (task/wiki or chat) wins. Orphan blobs remain possible and harmless.
    // A failed count is UNKNOWN, not zero — deleting on an unknown reference
    // set could strand a row pointing at a now-missing blob. Delete only when
    // both counts succeeded and their sum is zero.
    const deleteBlobIfUnreferenced = (key: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const taskRefs = yield* attachmentRepo.countByStorageKey(key).pipe(Effect.catchAll(() => Effect.succeed(null)));
        const chatRefs = yield* chatRepo.countByStorageKey(key).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (taskRefs !== null && chatRefs !== null && taskRefs + chatRefs === 0) {
          yield* storage.delete(key).pipe(Effect.catchAll(() => Effect.void));
        }
      });

    const uploadChat = (input: {
      projectId: string;
      chatId: string;
      filename: string;
      bytes: Uint8Array;
      actor: Actor;
    }): Effect.Effect<ChatAttachmentView,
      ChatAttachmentsDisabled | PayloadTooLarge | InvalidArgs | StorageError | DbError | ConstraintViolation | AssistantThreadNotFound> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        if (!chatAttachmentsEnabled(env)) return yield* new ChatAttachmentsDisabled();
        const filename = sanitizeFilename(input.filename);
        if (input.bytes.byteLength === 0) return yield* new InvalidArgs({ reason: `file '${filename}' is empty` });
        if (input.bytes.byteLength > CHAT_ATTACHMENT_MAX_UPLOAD_BYTES) {
          return yield* new PayloadTooLarge({ size: input.bytes.byteLength, maxBytes: CHAT_ATTACHMENT_MAX_UPLOAD_BYTES, filename });
        }
        const mimeType = resolveChatAttachmentMime(filename, input.bytes);
        if (mimeType === null) return yield* new InvalidArgs({ reason: `unsupported file type for '${filename}'` });
        // Claim a missing lazy thread before touching storage. Conflict-safe
        // insertion plus owner verification rejects a competing claim.
        yield* claimChatThread(input.chatId, input.projectId, input.actor.userId ?? null);
        const sha256 = createHash("sha256").update(input.bytes).digest("hex");
        const key = storageKeyFor(sha256);
        yield* storage.put(key, input.bytes);
        const id = randomUUID();
        yield* batch(db, [
          chatRepo.insertStmt({
            id,
            projectId: input.projectId,
            documentType: "chat",
            documentId: input.chatId,
            filename,
            mimeType,
            sizeBytes: input.bytes.byteLength,
            sha256,
            storageKey: key,
            uploadedBy: input.actor.userId ?? null,
          }),
        ]);
        const row = yield* chatRepo.findById(id).pipe(
          Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new DbError({ message: "chat attachment row vanished after insert" })))
        );
        return yield* toChatAttachment(row);
      });

    const listChat = (chatId: string, projectId: string, userId: string | null): Effect.Effect<ChatAttachmentView[],
      AssistantThreadNotFound | DbError> =>
      Effect.gen(function* () {
        if (!userId) return yield* new AssistantThreadNotFound({ documentType: "chat", documentId: chatId });
        const thread = yield* loadChatThread(chatId);
        if (!thread) return [];
        yield* requireChatOwner(chatId, projectId, userId);
        const rows = yield* chatRepo.findByOwnedThread("chat", chatId, projectId, userId);
        const list: ChatAttachmentView[] = [];
        for (const row of rows) list.push(yield* toChatAttachment(row));
        return list;
      });

    const findChatAttachment = (attachmentId: string, identity: AuthIdentityShape): Effect.Effect<ChatAttachmentRow,
      AttachmentNotFound | DbError> =>
      Effect.gen(function* () {
        const row = yield* chatRepo.findById(attachmentId);
        if (!row || row.document_type !== "chat") return yield* new AttachmentNotFound({ id: attachmentId });
        yield* requireChatOwner(row.document_id, row.project_id, identity.userId).pipe(
          Effect.catchTag("AssistantThreadNotFound", () => new AttachmentNotFound({ id: attachmentId }))
        );
        return row;
      });

    const serveChat = (attachmentId: string, identity: AuthIdentityShape): Effect.Effect<ServeChatAttachment,
      AttachmentNotFound | StorageError | DbError> =>
      Effect.gen(function* () {
        const row = yield* findChatAttachment(attachmentId, identity);
        const bytes = yield* storage.get(row.storage_key).pipe(
          Effect.catchTag("KeyNotFound", () => new AttachmentNotFound({ id: attachmentId }))
        );
        return { row, bytes, inline: isInlineMime(row.mime_type) };
      });

    const removeChat = (attachmentId: string, identity: AuthIdentityShape): Effect.Effect<void,
      AttachmentNotFound | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const row = yield* chatRepo.findById(attachmentId).pipe(
          Effect.flatMap((r) => r ? Effect.succeed(r) : Effect.fail(new AttachmentNotFound({ id: attachmentId })))
        );
        if (row.document_type !== "chat") return yield* new AttachmentNotFound({ id: attachmentId });
        yield* requireChatOwner(row.document_id, row.project_id, identity.userId).pipe(
          Effect.catchTag("AssistantThreadNotFound", () => new AttachmentNotFound({ id: attachmentId }))
        );
        yield* chatRepo.deleteById(attachmentId);
        yield* deleteBlobIfUnreferenced(row.storage_key);
      });

    // Best-effort: rows and blobs removed alongside the thread delete. Called
    // BEFORE the thread row is dropped (the FK cascade would hide the rows and
    // strand their blobs).
    const cleanupThreadAttachments = (documentType: string, documentId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const rows = yield* chatRepo.findByThread(documentType, documentId);
        if (rows.length === 0) return;
        yield* chatRepo.deleteByThread(documentType, documentId);
        const keys = Array.from(new Set(rows.map((r) => r.storage_key)));
        for (const key of keys) yield* deleteBlobIfUnreferenced(key);
      });

    return { upload, remove, findAttachment, serve, resolveShare, listForTask, listForWikiPage, uploadChat, listChat, findChatAttachment, serveChat, removeChat, cleanupThreadAttachments };
  }),
}) {}

