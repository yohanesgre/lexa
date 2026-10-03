// Assistant HttpApi handlers (chat/tasks + admin registry/usage/runs/bindings,
// MCP registry, Jev registry) — ADR-0003 §F.
//
// Workers-only module: it imports the assistant engine / gateway / MCP bridge,
// so the Bun entry (`server/entry.ts` → `http.ts`) never imports it. The Bun
// handler composes only the base groups, so `/api/assistant/*` and
// `/api/admin/assistant/*` 404 there; `createWorkersApiHandler` below mounts
// base + assistant.

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Cause, Effect, Either, Layer, Stream } from "effect";
import { dirname } from "node:path";
import { LoggerLayer } from "../logging/logger";
import { Db, queryAll, batch, RowNotFound, DbError, type BatchStmt, type DbDriver } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import {
  AssistantGenerationFailed,
  AssistantScheduleNotFound,
  AssistantTaskActive,
  AssistantThreadNotFound,
  HasChildren,
  InvalidArgs,
  NoUserContext,
  ProjectAccessDenied,
  ProviderAuthFailed,
  ProviderNotConfigured,
  ProviderUnreachable,
} from "./errors";
import { respond } from "./http-helpers";
import { AuthIdentity } from "./auth";
import { auth } from "../auth";
import { createApiMiddleware, type MiddlewareSession } from "./middleware";
import { ProjectService } from "../services/project.service";
import { AssistantService, buildChatExport } from "../services/assistant.service";
import { AssistantChatService } from "../services/assistant-chat.service";
import { AssistantTaskService } from "../services/assistant-task.service";
import { AssistantTaskRepo, type AdminAssistantRunKind } from "../repos/assistant-task.repo";
import { AssistantSettingsRepo } from "../repos/assistant-settings.repo";
import { AssistantThreadRepo } from "../repos/assistant-thread.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { listModels, pingChatCompletion, isCloudflareAiBaseUrl, normalizeBaseUrl, CLOUDFLARE_DEFAULT_MODEL, normalizeProviderKind, inferModelKind, assistantLog, type ProviderConfig } from "../assistant/provider";
import { AssistantProvidersRepo } from "../repos/assistant-providers.repo";
import { AssistantModelsRepo } from "../repos/assistant-models.repo";
import { AssistantCallLogsRepo } from "../repos/assistant-call-logs.repo";
import { AssistantModelPricesRepo } from "../repos/assistant-model-prices.repo";
import { AssistantHealthRepo } from "../repos/assistant-health.repo";
import { AssistantHealthService } from "../services/assistant-health.service";
import { AssistantMcpService, McpConnector, type McpUpdateInput } from "../services/assistant-mcp.service";
import { invalidateMcpDescriptorCache } from "../assistant/mcp-descriptors";
import { AssistantProvidersService, type ProviderUpdateInput } from "../services/assistant-providers.service";
import { AssistantJevService, type JevConfigInput } from "../services/assistant-jev.service";
import { AssistantJevRepo } from "../repos/assistant-jev.repo";
import { LiveMcpConnector } from "../assistant/mcp";
import { AssistantGateway } from "../assistant/gateway.service";
import { syncModelPrices } from "../assistant/price-sync";
import { createSchedule, deleteSchedule, getSchedule, listSchedules, updateSchedule } from "../scheduled/schedules";
import { AssistantThreadRpc, assistantThreadRpcNoop, type AssistantThreadRpcShape } from "../assistant/thread-rpc";
import { convertStoredMessages, type LegacyStoredMessage } from "../assistant/legacy-convert";
import { AuthorizationService } from "../services/authorization.service";
import { AttachmentService } from "../services/attachment.service";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig, type StorageConfigShape } from "../storage/config";
import { RuntimeEnvLive, storageEnvFrom, type RuntimeEnv } from "../runtime-env";
import { getEnv } from "../env";
import { ApiAuthHooks, type ApiAuthHooksShape } from "./auth-hooks";
import {
  LexaApi,
  baseRouteGroups,
  buildBaseServiceLayerWithStorage,
  createWorkersApiMiddleware,
  bootOrCrash,
  searchParams,
  requireAdmin,
  requireSuperadmin,
  requireProjectRead,
  requireProjectReadById,
  requireProjectAdminById,
} from "./http";
import type { AssistantTaskStatus } from "../../shared/types";
import type { StreamFrame } from "../../shared/assistant";

// Best-effort DO RPC from the shared handlers (ADR-0003 §B.4). On the Bun
// flavor the injected `AssistantThreadRpc` is the no-op layer (every call
// resolves null), so behavior is unchanged; on Workers a transport failure is
// no longer silent — `available` distinguishes "no DO here" (null is the
// fallback) from a real DO failure (logged, then the handler's D1 / in-process
// path is used).
const threadRpcCall = <A>(f: (rpc: AssistantThreadRpcShape) => Promise<A>): Effect.Effect<A | null, never, AssistantThreadRpc> =>
  Effect.gen(function* () {
    const rpc = yield* AssistantThreadRpc;
    return yield* Effect.tryPromise(() => f(rpc)).pipe(
      Effect.catchAll((e) =>
        rpc.available
          ? Effect.sync(() =>
              console.warn("[assistant] DO thread RPC failed:", e instanceof Error ? e.message : String(e))
            ).pipe(Effect.as(null))
          : Effect.succeed(null)
      )
    );
  });

// Engine-control forward (enqueue/abort). Reports whether a DO was present and
// acked, so call sites can honour the ADR §B.4 failure semantics instead of
// silently degrading. On Bun `available` is false (no DO — the in-process
// engine owns the task); on Workers a rejected call is `available: true,
// ok: false`.
const threadRpcControl = (
  f: (rpc: AssistantThreadRpcShape) => Promise<{ ok: true } | null>
): Effect.Effect<{ available: boolean; ok: boolean }, never, AssistantThreadRpc> =>
  Effect.gen(function* () {
    const rpc = yield* AssistantThreadRpc;
    if (!rpc.available) return { available: false, ok: false };
    return yield* Effect.tryPromise(() => f(rpc)).pipe(
      Effect.map((result) => ({ available: true, ok: result !== null })),
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.warn("[assistant] DO thread control RPC failed:", e instanceof Error ? e.message : String(e));
          return { available: true, ok: false };
        })
      )
    );
  });

const assistantLive = HttpApiBuilder.group(LexaApi, "assistant", (handlers) =>
  handlers
    .handle("getAssistantSettings", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectReadById(req.path.projectId);
        const repo = yield* AssistantSettingsRepo;
        return yield* repo.maskedView(req.path.projectId).pipe(
          Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId: req.path.projectId }))
        );
      }))
    )
    .handle("putAssistantSettings", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantSettingsRepo;
        const payload = {
          ...req.payload,
          ...(req.payload.writeTools !== undefined ? { writeTools: [...req.payload.writeTools] } : {}),
        };
        yield* repo.upsert(req.path.projectId, payload);
        return yield* repo.maskedView(req.path.projectId);
      }))
    )
    .handle("testAssistantSettings", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const gateway = yield* AssistantGateway;
        return yield* gateway.testConnection(req.path.projectId, {
          ...( (req.payload as { providerId?: string | null }).providerId !== undefined ? { providerId: (req.payload as { providerId?: string | null }).providerId } : {}),
          ...( (req.payload as { modelId?: string | null }).modelId !== undefined ? { modelId: (req.payload as { modelId?: string | null }).modelId } : {}),
          ...( (req.payload as { fallbackModelIds?: string[] }).fallbackModelIds !== undefined ? { fallbackModelIds: (req.payload as { fallbackModelIds?: string[] }).fallbackModelIds as string[] } : {}),
          ...( (req.payload as { kind?: string }).kind !== undefined ? { kind: (req.payload as { kind?: string }).kind as string } : {}),
          ...( (req.payload as { baseUrl?: string }).baseUrl !== undefined ? { baseUrl: (req.payload as { baseUrl?: string }).baseUrl as string } : {}),
          ...( (req.payload as { model?: string }).model !== undefined ? { model: (req.payload as { model?: string }).model as string } : {}),
          ...( (req.payload as { apiKey?: string }).apiKey !== undefined ? { apiKey: (req.payload as { apiKey?: string }).apiKey as string } : {}),
        }).pipe(
          Effect.tapError((e) =>
            Effect.sync(() => {
              const err = e as unknown as { _tag?: string; message?: string; stack?: string; cause?: unknown } & Record<string, unknown>;
              const stack = typeof err.stack === "string" ? err.stack.slice(0, 2000) : null;
              const causeRaw = err.cause as unknown;
              const cause = causeRaw === undefined || causeRaw === null ? null : causeRaw instanceof Error ? `${causeRaw.name}: ${causeRaw.message}`.slice(0, 800) : (() => { try { return (typeof causeRaw === "string" ? causeRaw : JSON.stringify(causeRaw)).slice(0, 800); } catch { return String(causeRaw).slice(0, 800); } })();
              let causeChain: string | null = null;
              try {
                const chain: string[] = [];
                let cur: unknown = e;
                for (let i = 0; i < 5; i++) {
                  const curCause = (cur as unknown as Record<string, unknown>)?.cause;
                  if (curCause === undefined || curCause === null) break;
                  chain.push(curCause instanceof Error ? `${(curCause as Error).name}: ${(curCause as Error).message}` : typeof curCause === "string" ? curCause.slice(0, 400) : JSON.stringify(curCause).slice(0, 400));
                  cur = curCause;
                  if (typeof cur !== "object" || cur === null) break;
                }
                if (chain.length > 0) causeChain = chain.join(" -> ").slice(0, 800);
              } catch {}
              const rawEvent = (() => { try { const v = (e as unknown as Record<string, unknown>).cause ?? (e as unknown as Record<string, unknown>).rawEvent ?? null; if (v === null || v === undefined) return null; return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 800); } catch { return null; } })();
              try {
                const line = JSON.stringify({
                  level: "ERROR",
                  service: "assistant-http",
                  message: `testAssistantSettings failed: ${String(err.message ?? err._tag ?? e).slice(0, 500)}`,
                  meta: {
                    projectId: req.path.projectId,
                    errorTag: err._tag ?? null,
                    status: 502,
                    stack,
                    cause,
                    causeChain,
                    rawEvent,
                    raw: String(err.message ?? e).slice(0, 800),
                  },
                  timestamp: new Date().toISOString(),
                });
                process.stderr.write(line + "\n");
              } catch {}
            })
          ),
          Effect.catchAllCause((cause) =>
            Effect.flatMap(Effect.logError(`[assistant-http] testAssistantSettings fiber failure: ${String(Cause.pretty(cause)).slice(0, 800)}`), () => Effect.failCause(cause))
          )
        );
      }))
    )
    .handle("listAssistantModels", (req) =>
      respond(Effect.gen(function* () {
        yield* requireAdmin;
        const config = yield* resolveProviderConfig(req.path.projectId, req.payload);
        return yield* Effect.tryPromise({
          try: async () => {
            try {
              return await listModels(config, fetch, { sessionId: `models-${req.path.projectId}` });
            } catch (e) {
              if (!isListingRouteAbsent(e)) throw e;
              if (normalizeProviderKind(config.kind) !== "openai_compatible") throw e;
              await pingChatCompletion({ ...config, model: listingFallbackModel(config) }, fetch, { sessionId: `models-${req.path.projectId}` });
              return { models: [] as Array<{ id: string }> };
            }
          },
          catch: (e) => e as ProviderAuthFailed | ProviderUnreachable,
        });
      }))
    )
    .handle("createAssistantTask", (req) =>
      respond(Effect.gen(function* () {
        const project = yield* requireProjectRead(req.payload.slug);
        const service = yield* AssistantService;
        const identity = yield* AuthIdentity;
        const task = yield* service.enqueue({
          projectId: project.id,
          documentType: req.payload.documentType,
          documentId: req.payload.documentId,
          prompt: req.payload.prompt,
          agentId: req.payload.agentId,
          skillId: req.payload.skillId,
          ...(req.payload.selection !== undefined ? { selection: req.payload.selection } : {}),
          ...(req.payload.attachments !== undefined ? { attachments: [...req.payload.attachments] } : {}),
        });
        const enqueue = yield* threadRpcControl((rpc) =>
          rpc.enqueueRun(`${req.payload.documentType}:${req.payload.documentId}`, {
            projectId: project.id,
            runId: task.id,
            actorUserId: identity.userId ?? "",
          })
        );
        // ADR-0003 §B.4: `enqueueRun` RPC failure → task marked `failed` + 502
        // ASSISTANT_UNAVAILABLE. TODO(P3): the DO `enqueueRun` is still a P2
        // stub returning `{ok:true}` and cannot fail, so there is no failure
        // branch to take yet; when the P3 engine can report a failed start,
        // branch on `enqueue` here (mark the task failed, fail the request).
        if (enqueue.available && !enqueue.ok) {
          yield* Effect.logWarning(
            `[assistant] enqueueRun RPC not acked for task ${task.id}; task left queued until the P3 failure path`
          );
        }
        return task;
      }))
    )
    .handle("getAssistantTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* AssistantTaskService;
        return yield* service.getById(req.path.id);
      }))
    )
    .handle("streamAssistantTask", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        const taskService = yield* AssistantTaskService;
        const task = yield* taskService.getById(req.path.id);
        if (identity.role !== "admin" && identity.userId) {
          const authz = yield* AuthorizationService;
          const access = yield* authz.projectAccess(identity.userId, task.projectId);
          if (!access) return yield* new ProjectAccessDenied({ project: task.projectId, role: "member" });
        }
        const service = yield* AssistantService;
        const frames = yield* service.runStream(req.path.id, { ...(identity.userId !== undefined && identity.userId !== null ? { userId: identity.userId } : {}) });
        wireDisconnectAbort(yield* HttpServerRequest, () => service.abortStream(req.path.id));
        return sseHttpResponse(frames);
      }))
    )
    .handle("cancelAssistantTask", (req) =>
      respond(Effect.gen(function* () {
        const service = yield* AssistantService;
        const taskService = yield* AssistantTaskService;
        if (!service.abortStream(req.path.id)) {
          yield* taskService.cancel(req.path.id);
        }
        const task = yield* taskService.getById(req.path.id).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (task) {
          const abort = yield* threadRpcControl((rpc) =>
            rpc.abortRun(`${task.documentType}:${task.documentId}`, req.path.id)
          );
          // ADR-0003 §B.4/§B.6: `abortRun` RPC failure is the assistant being
          // unavailable. TODO(P3): `abortRun` is still a P2 stub and the local
          // abort (`abortStream`/`taskService.cancel`) already ran above; once
          // the P3 engine owns the canonical turn, branch on `abort` here (502
          // ASSISTANT_UNAVAILABLE).
          if (abort.available && !abort.ok) {
            yield* Effect.logWarning(`[assistant] abortRun RPC not acked for task ${req.path.id}`);
          }
        }
        return { ok: true as const };
      }))
    )
    .handle("resetAssistantThread", (req) =>
      respond(Effect.gen(function* () {
        const threadRepo = yield* AssistantThreadRepo;
        const thread = yield* threadRepo.loadThread(req.path.documentType, req.path.documentId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: req.path.documentType, documentId: req.path.documentId }))
        );
        yield* requireProjectReadById(thread.projectId);
        const service = yield* AssistantService;
        yield* service.resetThread(thread.projectId, req.path.documentType, req.path.documentId);
        yield* threadRpcCall((rpc) => rpc.resetThread(`${req.path.documentType}:${req.path.documentId}`));
        return undefined;
      }))
    )
    .handle("streamAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        yield* requireProjectReadById(req.payload.projectId);
        const service = yield* AssistantService;
        const frames = yield* service.runChatStream(req.payload.chatId, identity.userId, {
          projectId: req.payload.projectId,
          chatId: req.payload.chatId,
          message: req.payload.message,
          agentId: req.payload.agentId,
          ...(req.payload.attachments ? { attachments: [...req.payload.attachments] } : {}),
          ...(req.payload.fromIndex !== undefined ? { fromIndex: req.payload.fromIndex } : {}),
          ...(req.payload.reasoningEffort !== undefined ? { reasoningEffort: req.payload.reasoningEffort } : {}),
        });
        wireDisconnectAbort(yield* HttpServerRequest, () => service.abortChat(req.payload.chatId));
        return sseHttpResponse(frames);
      }))
    )
    .handle("decideAssistantApproval", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const service = yield* AssistantService;
        return yield* service.decideApproval(req.path.id, identity.userId, req.payload.verdict);
      }))
    )
    .handle("resumeAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const threadRepo = yield* AssistantThreadRepo;
        const t = yield* threadRepo.loadChat(req.path.chatId, identity.userId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: req.path.chatId }))
        );
        yield* requireProjectReadById(t.projectId);
        const service = yield* AssistantService;
        const frames = yield* service.resumeChatStream(req.path.chatId, identity.userId);
        yield* threadRpcCall((rpc) => rpc.resumeBatch(`chat:${req.path.chatId}`, null));
        wireDisconnectAbort(yield* HttpServerRequest, () => service.abortChat(req.path.chatId));
        return sseHttpResponse(frames);
      }))
    )
    .handle("resumeAssistantThread", (req) =>
      respond(Effect.gen(function* () {
        const threadRepo = yield* AssistantThreadRepo;
        const thread = yield* threadRepo.loadThread(req.path.documentType, req.path.documentId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: req.path.documentType, documentId: req.path.documentId }))
        );
        yield* requireProjectReadById(thread.projectId);
        const service = yield* AssistantService;
        const frames = yield* service.resumeThreadStream(req.path.documentType, req.path.documentId);
        yield* threadRpcCall((rpc) => rpc.resumeBatch(`${req.path.documentType}:${req.path.documentId}`, null));
        wireDisconnectAbort(yield* HttpServerRequest, () => service.abortStream(req.path.documentId));
        return sseHttpResponse(frames);
      }))
    )
    .handle("getAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const threadRepo = yield* AssistantThreadRepo;
        const t = yield* threadRepo.loadChat(req.path.chatId, identity.userId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: req.path.chatId }))
        );
        const service = yield* AssistantService;
        // D3 (W7b/WS2): serve the DO canonical transcript in UIMessage-parts
        // shape; the D1 mirror is the fallback and is forward-converted so both
        // paths speak parts. Approvals reconciliation covers the carrier part
        // and the legacy `pendingBatch` field alike, so the decision endpoints
        // stay untouched.
        const doTranscript = yield* threadRpcCall((rpc) => rpc.getTranscript(`chat:${req.path.chatId}`));
        const doMessages =
          doTranscript && Array.isArray(doTranscript.messages) && doTranscript.messages.length > 0
            ? doTranscript.messages
            : null;
        const rawMessages = doMessages ?? convertStoredMessages(t.messages as LegacyStoredMessage[]);
        const messages = yield* service.reconcileChatApprovals(rawMessages);
        // DO-first: a non-null DO value (P3 engine) wins; otherwise the D1
        // mirror (the DO returns null until the engine tracks them).
        const doSummary = doTranscript ? doTranscript.summary : null;
        const doSummarizedCount = doTranscript ? doTranscript.summarizedCount : null;
        return {
          chatId: t.documentId,
          projectId: t.projectId,
          ownerUserId: t.ownerUserId,
          agentId: t.agentId,
          skillId: t.skillId,
          messages,
          summary: doSummary ?? t.summary,
          summarizedCount: doSummarizedCount ?? t.summarizedCount,
          permissionMode: doTranscript?.permissionMode ?? "ask",
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      }))
    )
    .handle("resetAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const service = yield* AssistantService;
        if (service.chatActive(req.path.chatId)) return yield* new AssistantTaskActive();
        const threadRepo = yield* AssistantThreadRepo;
        yield* threadRepo.loadChat(req.path.chatId, identity.userId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: req.path.chatId }))
        );
        // Attachment rows/blobs die with the conversation: explicit cleanup
        // BEFORE the thread row drops (the FK cascade would strand the blobs).
        const attachmentService = yield* AttachmentService;
        yield* attachmentService.cleanupThreadAttachments("chat", req.path.chatId);
        yield* threadRepo.resetThread("chat", req.path.chatId);
        yield* threadRpcCall((rpc) => rpc.destroyThread(`chat:${req.path.chatId}`));
        return undefined;
      }))
    )
    .handle("listAssistantChats", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const project = yield* requireProjectReadById(req.path.projectId);
        const service = yield* AssistantService;
        const q = searchParams(req).get("q") ?? undefined;
        return { data: yield* service.listChats(project.id, identity.userId, { ...(q !== undefined ? { q } : {}) }) };
      }))
    )
    .handle("renameAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const service = yield* AssistantService;
        const t = yield* service
          .updateChatMeta(req.path.chatId, identity.userId, { ...(req.payload.title !== undefined ? { title: req.payload.title } : {}), ...(req.payload.pinned !== undefined ? { pinned: req.payload.pinned } : {}) })
          .pipe(
            Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: req.path.chatId }))
          );
        return { chatId: t.documentId, title: t.title, pinned: t.pinned };
      }))
    )
    .handle("exportAssistantChat", (req) =>
      respond(Effect.gen(function* () {
        const identity = yield* AuthIdentity;
        if (!identity.userId) return yield* new NoUserContext();
        const threadRepo = yield* AssistantThreadRepo;
        const t = yield* threadRepo.loadChat(req.path.chatId, identity.userId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: req.path.chatId }))
        );
        return chatExportHttpResponse(t);
      }))
    )
    .handle("listAssistantMemory", (req) =>
      respond(Effect.gen(function* () {
        const project = yield* requireProjectReadById(req.path.projectId);
        const repo = yield* ProjectMemoryRepo;
        return { data: yield* repo.list(project.id) };
      }))
    )
    .handle("addAssistantMemory", (req) =>
      respond(Effect.gen(function* () {
        const project = yield* requireProjectReadById(req.path.projectId);
        const repo = yield* ProjectMemoryRepo;
        return yield* repo.create({ id: crypto.randomUUID(), projectId: project.id, content: req.payload.content });
      }))
    )
    .handle("removeAssistantMemory", (req) =>
      respond(Effect.gen(function* () {
        const project = yield* requireProjectReadById(req.path.projectId);
        const repo = yield* ProjectMemoryRepo;
        const entry = yield* repo.get(req.path.memoryId).pipe(
          Effect.catchTag("RowNotFound", () => new RowNotFound({ table: "project_memory" }))
        );
        if (entry.projectId !== project.id) {
          return yield* new RowNotFound({ table: "project_memory" });
        }
        yield* repo.remove(req.path.memoryId);
        return undefined;
      }))
    )
);


// Markdown transcript download: text/markdown attachment named after the
// (sanitized) thread title or "chat", suffixed with the updatedAt date.
function chatExportHttpResponse(t: { title: string | null; messages: unknown[]; updatedAt: string }): HttpServerResponse.HttpServerResponse {
  const sanitized = t.title?.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
  const day = t.updatedAt.slice(0, 10).replaceAll("-", "");
  const markdown = buildChatExport(t);
  return HttpServerResponse.raw(markdown, {
    contentType: "text/markdown; charset=utf-8",
    headers: { "Content-Disposition": `attachment; filename="${sanitized}-${day}.md"` },
  });
}

// SSE response bypasses the JSON encoder: StreamFrames are encoded as
// server-sent events with a 15s heartbeat comment to defeat proxy buffering.
function sseHttpResponse(frames: ReadableStream<StreamFrame>): HttpServerResponse.HttpServerResponse {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | null = null;
  let reader: ReadableStreamDefaultReader<StreamFrame> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      interval = setInterval(() => push(": ping\n\n"), 15_000);
      reader = frames.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            push(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
          }
        } catch {
          // upstream died mid-stream — close cleanly, client sees EOF
        } finally {
          closed = true;
          if (interval) clearInterval(interval);
          try {
            controller.close();
          } catch {
            // client cancelled mid-stream — controller already closed
          }
        }
      })();
    },
    cancel() {
      if (interval) clearInterval(interval);
      void reader?.cancel().catch(() => {});
    },
  });
  return HttpServerResponse.stream(
    Stream.fromReadableStream(() => stream, () => new AssistantGenerationFailed({ message: "SSE encode failed" })),
    { contentType: "text/event-stream", headers: { "Cache-Control": "no-cache" } }
  );
}

// Disconnect→abort (S5): the browser killing the fetch aborts the in-flight
// generation via the service's AbortController registry.
function wireDisconnectAbort(request: HttpServerRequest, abort: () => boolean): void {
  // `source` is the adapter's raw platform request (web Request here) — the
  // typed surface doesn't expose the abort signal.
  const signal = (request.source as { signal?: AbortSignal } | null | undefined)?.signal;
  if (!signal) return;
  signal.addEventListener("abort", () => abort());
}

// test/models take UNSAVED submitted values; an omitted apiKey falls back to
// the stored one so testing a saved config doesn't require re-entering the key.
// The baseline migration dropped the legacy kind/baseUrl/model/apiKey settings columns — payload is optional and fallback is gateway.
// Unsaved providerId/modelId (assistant-project.tsx Test) resolves to the same ProviderConfig as the persisted binding.
const resolveProviderConfig = (
  projectId: string,
  payload: { providerId?: string | null | undefined; modelId?: string | null | undefined; kind?: string | undefined; baseUrl?: string | undefined; model?: string | undefined; apiKey?: string | undefined }
): Effect.Effect<ProviderConfig, ProviderNotConfigured | ProviderAuthFailed | DbError, AssistantGateway | AssistantProvidersService | AssistantModelsRepo> =>
  Effect.gen(function* () {
    if (payload.providerId && payload.modelId) {
      const providersService = yield* AssistantProvidersService;
      const modelRepo = yield* AssistantModelsRepo;
      const provider = yield* providersService.view(payload.providerId).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new ProviderNotConfigured({ projectId }))));
      const model = yield* modelRepo.findByProviderAndModelId(payload.providerId, payload.modelId).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new ProviderNotConfigured({ projectId }))));
      if (!model.enabled) return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
      return {
        kind: normalizeProviderKind(model.kind),
        baseUrl: provider.baseUrl ?? "",
        model: model.modelId,
        apiKey: yield* providersService.resolveApiKey(payload.providerId),
        providerId: payload.providerId,
      };
    }
    if (payload.kind && payload.baseUrl && payload.model) {
      return {
        kind: normalizeProviderKind(payload.kind),
        baseUrl: payload.baseUrl,
        model: payload.model,
        apiKey: payload.apiKey ?? "",
      };
    }
    const gateway = yield* AssistantGateway;
    const configs = yield* gateway.resolveFallback(projectId);
    if (configs.length === 0) return yield* new ProviderNotConfigured({ projectId });
    return configs[0]!;
  });

// A listing route can be absent on OpenAI-compatible endpoints (Cloudflare's
// /ai/v1 answers 405 for GET /models; the catalog lives at /ai/models/search).
// The probe then falls back to a minimal chat completion so a provider that
// can chat is not reported unreachable. The row/imported model is preferred;
// the CF default covers a base URL with no models imported yet.
function listingFallbackModel(cfg: ProviderConfig): string {
  if (cfg.model && cfg.model !== "test") return cfg.model;
  try {
    return isCloudflareAiBaseUrl(normalizeBaseUrl(cfg.baseUrl, cfg.kind)) ? CLOUDFLARE_DEFAULT_MODEL : cfg.model;
  } catch {
    return cfg.model;
  }
}

function isListingRouteAbsent(e: unknown): boolean {
  return e instanceof ProviderUnreachable && (e.status === 404 || e.status === 405);
}

const adminAssistantLive = HttpApiBuilder.group(LexaApi, "adminAssistant", (handlers) =>
  handlers
    .handle("adminAssistantUsage", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantCallLogsRepo;
        const sp = searchParams(req);
        const from = sp.get("from");
        const to = sp.get("to");
        const projectId = sp.get("projectId");
        const filters = { from: from || null, to: to || null, projectId: projectId || null };
        const [stats, byDay, byModel] = yield* Effect.all([repo.usageStats(filters), repo.byDay(filters), repo.byModel(filters)], { concurrency: 3 });
        return { summary: stats, totalCostCents: stats.totalCostCents, byDay, byModel };
      }))
    )
    .handle("adminAssistantUsageCsv", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantCallLogsRepo;
        const sp = searchParams(req);
        const from = sp.get("from");
        const to = sp.get("to");
        const projectId = sp.get("projectId");
        const filters = { from: from || null, to: to || null, projectId: projectId || null };
        const csv = yield* repo.csv(filters);
        return HttpServerResponse.raw(csv, {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="assistant-usage.csv"` },
        });
      }))
    )
    .handle("adminAssistantPrices", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantModelPricesRepo;
        const rows = yield* repo.list();
        return { data: rows.map((r) => ({ model: r.model, prompt_price: r.promptPrice, completion_price: r.completionPrice, cached_read_price: r.cachedReadPrice, cached_write_price: r.cachedWritePrice, updated_at: r.updatedAt })) };
      }))
    )
    .handle("adminAssistantPutPrices", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const model = req.payload.model?.trim();
        if (!model) return yield* new InvalidArgs({ reason: "model is required" });
        const promptPrice = req.payload.prompt_price;
        const completionPrice = req.payload.completion_price;
        const cachedReadPrice = req.payload.cached_read_price;
        const cachedWritePrice = req.payload.cached_write_price;
        const decimalsOk = (n: number): boolean => {
          const s = String(n);
          const dot = s.indexOf(".");
          if (dot === -1) return true;
          return s.slice(dot + 1).length <= 6;
        };
        if (typeof promptPrice !== "number" || !Number.isFinite(promptPrice) || promptPrice < 0 || !decimalsOk(promptPrice)) {
          return yield* new InvalidArgs({ reason: "prompt_price must be a number >= 0 with max 6 decimals" });
        }
        if (typeof completionPrice !== "number" || !Number.isFinite(completionPrice) || completionPrice < 0 || !decimalsOk(completionPrice)) {
          return yield* new InvalidArgs({ reason: "completion_price must be a number >= 0 with max 6 decimals" });
        }
        if (typeof cachedReadPrice !== "number" || !Number.isFinite(cachedReadPrice) || cachedReadPrice < 0 || !decimalsOk(cachedReadPrice)) {
          return yield* new InvalidArgs({ reason: "cached_read_price must be a number >= 0 with max 6 decimals" });
        }
        if (typeof cachedWritePrice !== "number" || !Number.isFinite(cachedWritePrice) || cachedWritePrice < 0 || !decimalsOk(cachedWritePrice)) {
          return yield* new InvalidArgs({ reason: "cached_write_price must be a number >= 0 with max 6 decimals" });
        }
        const repo = yield* AssistantModelPricesRepo;
        const row = yield* repo.upsert({ model, promptPrice, completionPrice, cachedReadPrice, cachedWritePrice });
        return { model: row.model, prompt_price: row.promptPrice, completion_price: row.completionPrice, cached_read_price: row.cachedReadPrice, cached_write_price: row.cachedWritePrice, updated_at: row.updatedAt };
      }))
    )
    .handle("adminAssistantCalls", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantCallLogsRepo;
        const logs = yield* repo.listRecent(100);
        return { data: logs };
      }))
    )
    .handle("adminAssistantPriceSync", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const n = yield* syncModelPrices().pipe(Effect.catchAll(() => Effect.succeed(0)));
        const repo = yield* AssistantModelPricesRepo;
        const rows = yield* repo.list();
        return {
          synced: n,
          data: rows.map((r) => ({ model: r.model, prompt_price: r.promptPrice, completion_price: r.completionPrice, cached_read_price: r.cachedReadPrice, cached_write_price: r.cachedWritePrice, updated_at: r.updatedAt })),
        };
      }))
    )
    .handle("adminAssistantRuns", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantTaskRepo;
        const sp = searchParams(req);
        const statusRaw = sp.get("status");
        const statuses: ReadonlyArray<AssistantTaskStatus> = ["queued", "running", "completed", "failed", "cancelled"];
        let status: AssistantTaskStatus | null = null;
        if (statusRaw) {
          if (!statuses.includes(statusRaw as AssistantTaskStatus)) {
            return yield* new InvalidArgs({ reason: "status must be one of queued, running, completed, failed, cancelled" });
          }
          status = statusRaw as AssistantTaskStatus;
        }
        const kindRaw = sp.get("kind");
        const kinds: ReadonlyArray<AdminAssistantRunKind> = ["chat_run", "document", "schedule"];
        let kind: AdminAssistantRunKind | null = null;
        if (kindRaw) {
          if (!kinds.includes(kindRaw as AdminAssistantRunKind)) {
            return yield* new InvalidArgs({ reason: "kind must be one of chat_run, document, schedule" });
          }
          kind = kindRaw as AdminAssistantRunKind;
        }
        let limit = 50;
        const limitRaw = sp.get("limit");
        if (limitRaw !== null) {
          const parsed = Number(limitRaw);
          if (!Number.isInteger(parsed) || parsed < 1) {
            return yield* new InvalidArgs({ reason: "limit must be a positive integer" });
          }
          limit = Math.min(parsed, 200);
        }
        let cursor: { createdAt: string; id: string } | null = null;
        const cursorRaw = sp.get("cursor");
        if (cursorRaw) {
          const sep = cursorRaw.indexOf("|");
          if (sep <= 0 || sep === cursorRaw.length - 1) {
            return yield* new InvalidArgs({ reason: "cursor is malformed" });
          }
          cursor = { createdAt: cursorRaw.slice(0, sep), id: cursorRaw.slice(sep + 1) };
        }
        const projectId = sp.get("projectId");
        const { runs, nextCursor } = yield* repo.listRecentRuns({ status, projectId: projectId || null, kind, limit, cursor });
        const counts = yield* repo.countRunsByStatus();
        return { data: runs, nextCursor: nextCursor ? `${nextCursor.createdAt}|${nextCursor.id}` : null, counts };
      }))
    )
    .handle("adminAssistantBindings", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantSettingsRepo;
        const rows = yield* repo.listBindingsOverview();
        return { data: rows };
      }))
    )
    .handle("adminAssistantProviders", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        // One request, both reads: the rows and the managed-secrets capability
        // the form needs to decide whether a key can be stored at all.
        const [data, secretsEnabled] = yield* Effect.all([service.list(), service.secretsEnabled()], { concurrency: 2 });
        return { data, secretsEnabled };
      }))
    )
    .handle("adminAssistantCreateProvider", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        return yield* service.create({ label: req.payload.label!, baseUrl: req.payload.baseUrl!, apiKey: req.payload.apiKey ?? "" });
      }))
    )
    .handle("adminAssistantUpdateProvider", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        const patch: ProviderUpdateInput = {};
        if (req.payload.label !== undefined) patch.label = req.payload.label;
        if (req.payload.baseUrl !== undefined) patch.baseUrl = req.payload.baseUrl;
        // Carried only when present: an omitted/blank `apiKey` is "keep".
        if (req.payload.apiKey !== undefined) patch.apiKey = req.payload.apiKey;
        if (req.payload.clearKey !== undefined) patch.clearKey = req.payload.clearKey;
        return yield* service.update(req.path.id, patch);
      }))
    )
    .handle("adminAssistantDeleteProvider", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const db = yield* Db;
        const mRepo = yield* AssistantModelsRepo;
        const models = yield* mRepo.listByProvider(req.path.id).pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ id: string }>)));
        if (models.length > 0) {
          const modelIds = new Set(models.map((m) => m.id));
          const rows = yield* queryAll<{ fallback_model_ids: string }>(db, `SELECT fallback_model_ids FROM assistant_settings`);
          let refs = 0;
          for (const r of rows) {
            try {
              const ids = JSON.parse(r.fallback_model_ids ?? "[]") as string[];
              for (const fid of ids) if (modelIds.has(fid)) refs++;
            } catch {}
          }
          if (refs > 0) return yield* new HasChildren({ count: refs });
        }
        const service = yield* AssistantProvidersService;
        yield* service.remove(req.path.id);
        return undefined;
      }))
    )
    .handle("adminAssistantTestProvider", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        const mRepo = yield* AssistantModelsRepo;
        const prov = yield* service.view(req.path.id);
        const models = yield* mRepo.listByProvider(req.path.id).pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ kind: string; enabled: boolean; modelId: string }>)));
        const firstEnabled = (models as Array<{ kind: string; enabled: boolean; modelId: string }>).find((m) => m.enabled);
        const kind: ProviderConfig["kind"] = normalizeProviderKind(firstEnabled?.kind ?? (models[0] as { kind?: string } | undefined)?.kind ?? "openai_compatible");
        const model = firstEnabled?.modelId ?? (models[0] as { modelId?: string } | undefined)?.modelId ?? "test";
        const cfg: ProviderConfig = { kind, baseUrl: prov.baseUrl, apiKey: yield* service.resolveApiKey(req.path.id), model, sessionId: `provider-test-${req.path.id}` };
        const start = Date.now();
        yield* Effect.tryPromise({
          try: async () => {
            try {
              await listModels(cfg);
              return;
            } catch (e) {
              if (!isListingRouteAbsent(e)) throw e;
              if (normalizeProviderKind(cfg.kind) !== "openai_compatible") throw e;
              await pingChatCompletion({ ...cfg, model: listingFallbackModel(cfg) });
            }
          },
          catch: (e) => e as ProviderAuthFailed | ProviderUnreachable,
        });
        return { ok: true, latencyMs: Date.now() - start };
      }))
    )
    .handle("adminAssistantProviderModels", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        const mRepo = yield* AssistantModelsRepo;
        const prov = yield* service.view(req.path.id);
        // One pre-read serves both the test config (kind/model) and the
        // update-or-create set below.
        const rows = (yield* mRepo.listByProvider(req.path.id).pipe(
          Effect.catchAll(() => Effect.succeed([] as Array<{ id: string; modelId: string; priority: number; kind: string; enabled: boolean }>))
        )) as Array<{ id: string; modelId: string; priority: number; kind: string; enabled: boolean }>;
        const enabledKind = rows.find((m) => m.enabled)?.kind;
        const kind: ProviderConfig["kind"] = normalizeProviderKind(enabledKind ?? "openai_compatible");
        const firstEnabledModel = rows.find((m) => m.enabled)?.modelId;
        const model = firstEnabledModel ?? rows[0]?.modelId ?? "test";
        const cfg: ProviderConfig = { kind, baseUrl: prov.baseUrl, apiKey: yield* service.resolveApiKey(req.path.id), model, sessionId: `provider-models-${req.path.id}` };
        const catalog = yield* Effect.tryPromise({
          try: () => listModels(cfg),
          catch: (e) => e as ProviderAuthFailed | ProviderUnreachable,
        });
        const db = yield* Db;
        const existingById = new Map(rows.map((r) => [r.modelId, r]));
        const maxPriority = rows.reduce((m, r) => Math.max(m, r.priority), -1);
        let nextPriority = maxPriority + 1;
        // All kind auto-corrections and new models ride ONE atomic batch. The
        // read above sits outside the batch, so a concurrent reorder/model sync
        // between the read and the batch can trip UNIQUE(provider_id, priority);
        // the whole batch then rolls back and the request fails (retryable) —
        // same contract as the other converted read-then-batch sites.
        const stmts: BatchStmt[] = [];
        for (const m of catalog.models) {
          const inferred = inferModelKind(m.id);
          const found = existingById.get(m.id);
          if (found) {
            const current = normalizeProviderKind(found.kind);
            // `inferModelKind` can never return `workers_ai` (a Workers-only
            // kind with no wire signature), so auto-correcting a manually
            // registered Workers AI row would silently flip it to
            // `openai_compatible`. Only the three catalog-inferable kinds are
            // corrected.
            if (current !== "workers_ai" && current !== inferred) {
              const stmt = mRepo.updateStmt(found.id, { kind: inferred });
              if (stmt) stmts.push(stmt);
              assistantLog("WARN", "assistant model kind auto-corrected", { providerId: req.path.id, modelId: m.id, from: found.kind, to: inferred });
            }
            continue;
          }
          stmts.push(mRepo.createStmt({ id: crypto.randomUUID(), providerId: req.path.id, modelId: m.id, kind: inferred, priority: nextPriority++, enabled: false }));
        }
        if (stmts.length > 0) yield* batch(db, stmts);
        const fresh = yield* mRepo.listByProvider(req.path.id);
        return { data: fresh };
      }))
    )
    .handle("adminAssistantUpdateModel", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const pRepo = yield* AssistantProvidersRepo;
        const mRepo = yield* AssistantModelsRepo;
        yield* pRepo.getById(req.path.id);
        const found = yield* mRepo.findByProviderAndModelId(req.path.id, req.path.modelId);
        const patch: { enabled?: boolean; priority?: number } = {};
        if (req.payload.enabled !== undefined) patch.enabled = req.payload.enabled;
        if (req.payload.priority !== undefined) patch.priority = req.payload.priority;
        return yield* mRepo.update(found.id, patch);
      }))
    )
    .handle("adminAssistantReorderModels", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const repo = yield* AssistantModelsRepo;
        const rows = yield* repo.reorder(req.path.id, [...req.payload.orderedIds]);
        return { data: rows };
      }))
    )
    .handle("adminAssistantHealth", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const svc = yield* AssistantHealthService;
        return yield* svc.getHealth(req.path.id);
      }))
    )
    .handle("adminAssistantProbeProvider", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantProvidersService;
        const mRepo = yield* AssistantModelsRepo;
        const healthSvc = yield* AssistantHealthService;
        const prov = yield* service.view(req.path.id);
        const models = yield* mRepo.listByProvider(req.path.id).pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ kind: string; enabled: boolean; modelId: string }>)));
        const firstEnabled = (models as Array<{ kind: string; enabled: boolean; modelId: string }>).find((m) => m.enabled);
        const kind: ProviderConfig["kind"] = normalizeProviderKind(firstEnabled?.kind ?? (models[0] as { kind?: string } | undefined)?.kind ?? "openai_compatible");
        const model = firstEnabled?.modelId ?? (models[0] as { modelId?: string } | undefined)?.modelId ?? "test";
        const cfg: ProviderConfig = { kind, baseUrl: prov.baseUrl, apiKey: yield* service.resolveApiKey(req.path.id), model, sessionId: `provider-probe-${req.path.id}` };
        const probed = yield* Effect.tryPromise({
          try: () => listModels(cfg),
          catch: (e) => e as ProviderAuthFailed | ProviderUnreachable,
        }).pipe(Effect.either);
        if (Either.isRight(probed)) yield* healthSvc.recordSuccess(req.path.id);
        else yield* healthSvc.recordFailure(req.path.id);
        return yield* healthSvc.getHealth(req.path.id);
      }))
    )
);

const projectAssistantUsageLive = HttpApiBuilder.group(LexaApi, "projectAssistantUsage", (handlers) =>
  handlers.handle("projectAssistantUsage", (req) =>
    respond(Effect.gen(function* () {
      yield* requireSuperadmin;
      const projectService = yield* ProjectService;
      const repo = yield* AssistantCallLogsRepo;
      const project = yield* projectService.findBySlug(req.path.slug);
      const sp = searchParams(req);
      const from = sp.get("from");
      const to = sp.get("to");
      const filters = { from: from || null, to: to || null, projectId: project.id };
      const [stats, byDay, byModel] = yield* Effect.all([repo.usageStats(filters), repo.byDay(filters), repo.byModel(filters)], { concurrency: 3 });
      return { summary: stats, totalCostCents: stats.totalCostCents, byDay, byModel };
    }))
  )
);

// Managed-only (2026-09-28): a `secretRef` in a create/update payload is
// accepted for typed-client compatibility and ignored. One structured WARN per
// request records it, in the same stderr JSON shape as the assistant log lines;
// the offending ref is never echoed. Never touches the registry or the service.
function warnIgnoredMcpSecretRef(operation: "create" | "update", ref: string | null | undefined, serverId?: string): void {
  if (typeof ref !== "string" || ref.trim() === "") return;
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: "WARN",
        service: "assistant-mcp",
        message: `MCP secretRef ignored — references are no longer supported (${operation})`,
        meta: { operation, ...(serverId !== undefined ? { serverId } : {}) },
        timestamp: new Date().toISOString(),
      })}\n`
    );
  } catch {
    // logging must never fail the request
  }
}

const assistantMcpLive = HttpApiBuilder.group(LexaApi, "assistantMcp", (handlers) =>
  handlers
    .handle("listMcpServers", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantMcpService;
        // One request, both reads: the rows and the managed-secrets capability
        // the form needs to decide whether a token can be stored at all.
        const [data, managedSecretsEnabled] = yield* Effect.all([service.list(), service.managedSecretsEnabled()], {
          concurrency: 2,
        });
        return { data, managedSecretsEnabled };
      }))
    )
    .handle("createMcpServer", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        warnIgnoredMcpSecretRef("create", req.payload.secretRef);
        const service = yield* AssistantMcpService;
        const created = yield* service.create({
          label: req.payload.label,
          transportType: req.payload.transportType,
          url: req.payload.url ?? null,
          command: req.payload.command ?? null,
          args: req.payload.args !== undefined ? [...req.payload.args] : [],
          // Carried only when present: an omitted `secret` is "no managed
          // token", which the service needs to tell apart from a keep.
          ...(req.payload.secret !== undefined && req.payload.secret !== null ? { secret: req.payload.secret } : {}),
          ...(req.payload.enabled !== undefined ? { enabled: req.payload.enabled } : {}),
        });
        // Registry write → the DO descriptor cache is stale (H6).
        invalidateMcpDescriptorCache();
        return created;
      }))
    )
    .handle("updateMcpServer", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        warnIgnoredMcpSecretRef("update", req.payload.secretRef, req.path.id);
        const service = yield* AssistantMcpService;
        const patch: McpUpdateInput = {};
        if (req.payload.label !== undefined) patch.label = req.payload.label;
        if (req.payload.transportType !== undefined) patch.transportType = req.payload.transportType;
        if (req.payload.url !== undefined) patch.url = req.payload.url;
        if (req.payload.command !== undefined) patch.command = req.payload.command;
        if (req.payload.args !== undefined) patch.args = [...req.payload.args];
        if (req.payload.secret !== undefined && req.payload.secret !== null) patch.secret = req.payload.secret;
        if (req.payload.clearSecret !== undefined) patch.clearSecret = req.payload.clearSecret;
        if (req.payload.enabled !== undefined) patch.enabled = req.payload.enabled;
        const updated = yield* service.update(req.path.id, patch);
        invalidateMcpDescriptorCache();
        return updated;
      }))
    )
    .handle("deleteMcpServer", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantMcpService;
        yield* service.remove(req.path.id);
        invalidateMcpDescriptorCache();
        return undefined;
      }))
    )
    .handle("testMcpServer", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantMcpService;
        return yield* service.testConnection(req.path.id);
      }))
    )
    .handle("listProjectMcpServers", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectReadById(req.path.id);
        const service = yield* AssistantMcpService;
        return { data: yield* service.listForProject(req.path.id) };
      }))
    )
    .handle("putProjectMcpServers", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectAdminById(req.path.id);
        const service = yield* AssistantMcpService;
        yield* service.setProjectServers(
          req.path.id,
          req.payload.entries.map((e) => ({ serverId: e.serverId, enabled: e.enabled }))
        );
        invalidateMcpDescriptorCache(req.path.id);
        return { data: yield* service.listForProject(req.path.id) };
      }))
    )
);

const assistantJevLive = HttpApiBuilder.group(LexaApi, "assistantJev", (handlers) =>
  handlers
    .handle("getAssistantJev", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantJevService;
        return yield* service.readConfig();
      }))
    )
    .handle("updateAssistantJev", (req) =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantJevService;
        const patch: JevConfigInput = {};
        if (req.payload.baseUrl !== undefined) patch.baseUrl = req.payload.baseUrl;
        if (req.payload.model !== undefined) patch.model = req.payload.model;
        if (req.payload.enabled !== undefined) patch.enabled = req.payload.enabled;
        // Carried only when present: an omitted/blank `secret` is "keep".
        if (req.payload.secret !== undefined && req.payload.secret !== null) patch.secret = req.payload.secret;
        if (req.payload.clearSecret !== undefined) patch.clearSecret = req.payload.clearSecret;
        return yield* service.updateConfig(patch);
      }))
    )
    .handle("testAssistantJev", () =>
      respond(Effect.gen(function* () {
        yield* requireSuperadmin;
        const service = yield* AssistantJevService;
        return yield* service.probe();
      }))
    )
    .handle("getProjectJev", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectReadById(req.path.id);
        const service = yield* AssistantJevService;
        const repo = yield* AssistantJevRepo;
        const [row, available] = yield* Effect.all([repo.getProject(req.path.id), service.projectAvailable()], { concurrency: 2 });
        return row === null
          ? { projectId: req.path.id, enabled: false, available, createdAt: null, updatedAt: null }
          : { projectId: row.project_id, enabled: row.enabled === 1, available, createdAt: row.created_at, updatedAt: row.updated_at };
      }))
    )
    .handle("putProjectJev", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectAdminById(req.path.id);
        const service = yield* AssistantJevService;
        const repo = yield* AssistantJevRepo;
        const [row, available] = yield* Effect.all([repo.setProject(req.path.id, req.payload.enabled), service.projectAvailable()], { concurrency: 2 });
        return { projectId: row.project_id, enabled: row.enabled === 1, available, createdAt: row.created_at, updatedAt: row.updated_at };
      }))
    )
);


// Scheduled assistant runs (ADR-0004 §4; H7): CRUD over the per-project
// `assistant_schedules` rows. Reads are member-gated; writes admin-gated and
// attributed to the caller. Timing validity is enforced by the service
// (`InvalidArgs` → 422); an unknown/other-project row maps to 404.
const assistantSchedulesLive = HttpApiBuilder.group(LexaApi, "assistantSchedules", (handlers) =>
  handlers
    .handle("listAssistantSchedules", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectReadById(req.path.projectId);
        const db = yield* Db;
        return { data: yield* listSchedules(db, req.path.projectId) };
      }))
    )
    .handle("getAssistantSchedule", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectReadById(req.path.projectId);
        const db = yield* Db;
        return yield* getSchedule(db, req.path.id, req.path.projectId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantScheduleNotFound({ id: req.path.id }))
        );
      }))
    )
    .handle("createAssistantSchedule", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectAdminById(req.path.projectId);
        const identity = yield* AuthIdentity;
        const db = yield* Db;
        return yield* createSchedule(db, req.path.projectId, { ...req.payload }, identity.userId);
      }))
    )
    .handle("updateAssistantSchedule", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectAdminById(req.path.projectId);
        const db = yield* Db;
        return yield* updateSchedule(db, req.path.id, req.path.projectId, { ...req.payload }).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantScheduleNotFound({ id: req.path.id }))
        );
      }))
    )
    .handle("deleteAssistantSchedule", (req) =>
      respond(Effect.gen(function* () {
        yield* requireProjectAdminById(req.path.projectId);
        const db = yield* Db;
        yield* deleteSchedule(db, req.path.id, req.path.projectId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantScheduleNotFound({ id: req.path.id }))
        );
        return undefined;
      }))
    )
);

// ── Assistant service layer (Workers-only) ──────────────────────────────
// Engine, gateway, MCP bridge, and the assistant-only repos/services. Kept
// out of `http.ts`'s base layer so the Bun bundle never imports
// `@tanstack/ai*` / `agents` (ADR-0003 §F). `AssistantCatalogService` stays
// in the base layer — the agents/skills catalog survives on both flavors.

export function assistantServiceLayerWithStorage(
  storageCfg: StorageConfigShape,
  mcpConnector?: Layer.Layer<McpConnector>,
  threadRpc?: AssistantThreadRpcShape
) {
  return Layer.mergeAll(
    AssistantSettingsRepo.Default, AssistantThreadRepo.Default, ProjectMemoryRepo.Default,
    AssistantTaskRepo.Default,
    AssistantChatService.Default.pipe(
      Layer.provide(Layer.mergeAll(storageLayerFor(storageCfg), Layer.succeed(StorageConfig, storageCfg)))
    ),
    AssistantTaskService.Default.pipe(
      Layer.provide(Layer.mergeAll(storageLayerFor(storageCfg), Layer.succeed(StorageConfig, storageCfg)))
    ),
    AssistantService.Default.pipe(
      Layer.provide(Layer.mergeAll(storageLayerFor(storageCfg), Layer.succeed(StorageConfig, storageCfg)))
    ),
    AssistantProvidersRepo.Default, AssistantModelsRepo.Default, AssistantCallLogsRepo.Default, AssistantModelPricesRepo.Default,
    AssistantProvidersService.Default,
    AssistantHealthRepo.Default, AssistantHealthService.Default, AssistantGateway.Default,
    AssistantMcpService.Default.pipe(Layer.provide(mcpConnector ?? LiveMcpConnector)),
    AssistantJevRepo.Default, AssistantJevService.Default,
    Layer.succeed(AssistantThreadRpc, threadRpc ?? assistantThreadRpcNoop),
  );
}

const storageLayerFor = (cfg: StorageConfigShape) =>
  Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg)));

const apiLayer = HttpApiBuilder.api(LexaApi);

// Full route groups (Workers): the base groups plus the assistant lives.
function fullRouteGroups() {
  return Layer.mergeAll(
    baseRouteGroups(),
    assistantLive, adminAssistantLive, projectAssistantUsageLive, assistantMcpLive, assistantJevLive, assistantSchedulesLive
  );
}

// ─── Workers-side factory ───────────────────────────────────────────────
// Same route groups as the Bun host plus the assistant tier, composed over a
// caller-supplied DbDriver (D1 on Workers) with per-request env, R2 storage,
// a per-request better-auth instance, and the DO thread RPC. The webhook stays
// outside this app (raw-body HMAC before parse — workers-entry.ts owns it).

export interface WorkersApiHandlerOptions {
  driver: DbDriver;
  runtimeEnv: RuntimeEnv;
  storage: StorageConfigShape;
  authHooks: ApiAuthHooksShape;
  getSession?: ((headers: Headers) => Promise<MiddlewareSession | null>) | undefined;
  // DO-backed thread RPC (ADR-0003 §B.4). Built in workers-entry.ts from the
  // ASSISTANT_AGENT namespace so this module stays free of `agents` imports.
  threadRpc?: AssistantThreadRpcShape | undefined;
  // MCP connector seam for tests; defaults to the live @tanstack/ai-mcp bridge.
  mcpConnector?: Layer.Layer<McpConnector> | undefined;
}

export function createWorkersApiHandler(opts: WorkersApiHandlerOptions) {
  const { driver, runtimeEnv, storage, authHooks } = opts;
  const dbLayer = Layer.mergeAll(
    Layer.succeed(Db, driver),
    RuntimeEnvLive(runtimeEnv),
    Layer.succeed(ApiAuthHooks, authHooks),
  );
  const serviceLayer = Layer.mergeAll(
    buildBaseServiceLayerWithStorage(storage),
    assistantServiceLayerWithStorage(storage, opts.mcpConnector, opts.threadRpc),
  );
  const handlerLayer = fullRouteGroups().pipe(
    Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))),
    Layer.provide(dbLayer)
  );
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  const finalLayer = Layer.provide(
    merged,
    createWorkersApiMiddleware(driver, runtimeEnv, storage, { getSession: opts.getSession })
  );
  const { handler } = HttpApiBuilder.toWebHandler(finalLayer as never);
  return async (req: Request) => handler(req);
}

// ─── Bun-host factory including the assistant (tests only) ──────────────
// The Bearer-key assistant suites need a full-surface handler over a local
// sqlite file (better-auth singleton, env-resolved storage). Production Bun
// uses the base-only `createApiHandler`; this is never imported by the Bun
// entry, so it never reaches the Bun bundle.

export function createAssistantApiHandler(
  dbPath: string,
  env?: RuntimeEnv,
  opts?: { mcpConnector?: Layer.Layer<McpConnector> }
) {
  const ready = bootOrCrash(buildBunFullApp(dbPath, env, opts?.mcpConnector));
  return async (req: Request) => {
    const start = Date.now();
    const url = new URL(req.url);
    try {
      const { handler } = await ready;
      const res = await handler(req);
      const level = res.status >= 500 ? "ERROR" : res.status >= 400 ? "WARN" : "INFO";
      console.log(JSON.stringify({ level, service: "http", method: req.method, path: url.pathname, status: res.status, duration: Date.now() - start, timestamp: new Date().toISOString() }));
      return res;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      console.log(JSON.stringify({ level: "ERROR", service: "http", method: req.method, path: url.pathname, status: 500, duration: Date.now() - start, timestamp: new Date().toISOString(), error: e.message, stack: e.stack }));
      return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Internal error" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  };
}

async function buildBunFullApp(
  dbPath: string,
  env?: RuntimeEnv,
  mcpConnector?: Layer.Layer<McpConnector>
) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const driver = createBunSqliteDriver(db);
  const dbLayer = Layer.mergeAll(
    Layer.succeed(Db, driver),
    Layer.succeed(ApiAuthHooks, {
      createUser: (input) =>
        auth.api.createUser({ body: { ...input, data: { role: "superadmin" } } }),
      listSessions: (headers) => auth.api.listSessions({ headers }),
      revokeSession: ({ token, headers }) => auth.api.revokeSession({ body: { token }, headers }),
    } satisfies ApiAuthHooksShape),
  );
  const storageCfg = resolveStorageConfig(storageEnvFrom(env ?? getEnv()), dirname(dbPath));
  const serviceLayer = Layer.mergeAll(
    buildBaseServiceLayerWithStorage(storageCfg),
    assistantServiceLayerWithStorage(storageCfg, mcpConnector),
  );
  const handlerLayer = fullRouteGroups().pipe(
    Layer.provide(Layer.provide(serviceLayer, Layer.mergeAll(dbLayer, LoggerLayer))),
    Layer.provide(dbLayer)
  );
  const merged = Layer.mergeAll(apiLayer, handlerLayer);
  const finalLayer = Layer.provide(
    merged,
    createApiMiddleware(db, dbPath, env, { getSession: (headers) => auth.api.getSession({ headers }) })
  );
  const { handler } = HttpApiBuilder.toWebHandler(finalLayer as never);
  return { handler, driver };
}
