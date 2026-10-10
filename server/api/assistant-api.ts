// Assistant HttpApi handlers (chat/tasks + admin registry/usage/runs/bindings,
// MCP registry, Jev registry) — ADR-0003 §F, mounted on both flavors by ADR-0005
// D7.
//
// `http.ts` composes the base groups and the Bun handler mounts these assistant
// groups via a dynamic import of `fullRouteGroups()` / `assistantServiceLayerWithStorage`
// (never a static cycle). `createWorkersApiHandler` below does the same for D1.
// The module is `agents`-free: the retired DO executor is not on this path.

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Cause, Effect, Either, Layer, Stream } from "effect";
import { dirname } from "node:path";
import { LoggerLayer } from "../logging/logger";
import { Db, queryAll, batch, RowNotFound, DbError, type BatchStmt, type DbDriver } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import {
  AssistantGenerationFailed,
  AssistantRunNotFound,
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
  VisionNotConfigured,
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
import { listModels, pingChatCompletion, isCloudflareAiBaseUrl, normalizeBaseUrl, CLOUDFLARE_DEFAULT_MODEL, normalizeProviderKind, inferModelKindForProvider, assistantLog, type ProviderConfig } from "../assistant/provider";
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
import { getAssistantRunById } from "../assistant/run-registry";
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

// ADR-0005 W4: the DO thread RPC is gone from every live path — chat resume,
// delegated-run abort, transcript read, and thread reset/destroy all run
// in-process. The `AssistantThreadRpc` seam and its DO modules stay in the tree
// (W6 deletes them) but nothing here imports them.

// Run read/abort gate: a run in a project the caller cannot read is not
// disclosed — it answers the same 404 as an unknown run id (no existence
// oracle), so a foreign project's run is indistinguishable from a missing one.
const requireRunProjectRead = (
  projectId: string,
  runId: string
): Effect.Effect<void, AssistantRunNotFound | DbError, AuthIdentity | ProjectService | AuthorizationService> =>
  requireProjectReadById(projectId).pipe(
    Effect.asVoid,
    Effect.catchTags({
      ProjectAccessDenied: () => new AssistantRunNotFound({ id: runId }),
      ProjectNotFound: () => new AssistantRunNotFound({ id: runId }),
    })
  );

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
        const modelsRepo = yield* AssistantModelsRepo;
        const payload = {
          ...req.payload,
          ...(req.payload.writeTools !== undefined ? { writeTools: [...req.payload.writeTools] } : {}),
        };
        // A submitted vision agent must resolve to an enabled model of the
        // effective primary provider, so `analyze_image` is never offered against
        // an unresolvable binding (which would answer a bare "unknown read tool").
        const visionModel = (req.payload as { visionModel?: string | null }).visionModel;
        if (typeof visionModel === "string" && visionModel !== "") {
          const existing = yield* repo
            .getByProject(req.path.projectId)
            .pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
          const payloadProviderId = (req.payload as { providerId?: string | null }).providerId;
          // An explicit null clears the binding — only an omitted field falls back
          // to the stored provider (a `??` would skip the explicit null).
          const providerId =
            payloadProviderId !== undefined
              ? payloadProviderId
              : (existing as { provider_id?: string | null } | null)?.provider_id ?? null;
          const model = providerId === null
            ? null
            : yield* modelsRepo
                .findByProviderAndModelId(providerId, visionModel)
                .pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
          if (model === null || !model.enabled) return yield* new VisionNotConfigured();
        }
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
              // The ping fallback covers every OpenAI-wire kind (including
              // `workers_ai`); Anthropic/Responses never take it.
              if (normalizeProviderKind(config.kind) !== "openai_compatible" && normalizeProviderKind(config.kind) !== "workers_ai") throw e;
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
        // ADR-0005 W3: the client starts the document run by POSTing to
        // /assistant/tasks/:id/stream (the in-process SSE task lane). The create
        // route only enqueues the row — no DO `enqueueRun` RPC.
        return yield* service.enqueue({
          projectId: project.id,
          documentType: req.payload.documentType,
          documentId: req.payload.documentId,
          prompt: req.payload.prompt,
          agentId: req.payload.agentId,
          ...(req.payload.skillId !== undefined ? { skillId: req.payload.skillId } : {}),
          ...(req.payload.selection !== undefined ? { selection: req.payload.selection } : {}),
          ...(req.payload.attachments !== undefined ? { attachments: [...req.payload.attachments] } : {}),
        });
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
        // ADR-0005 W3: cancel is in-process only — abort the live SSE run (its
        // abort branch terminalizes the task row via `onCancel`) or, when no
        // stream is active, transition the row directly. The task row stays the
        // terminal authority; no DO `abortRun` RPC.
        const service = yield* AssistantService;
        const taskService = yield* AssistantTaskService;
        if (!service.abortStream(req.path.id)) {
          yield* taskService.cancel(req.path.id);
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
          ...(req.payload.permissionMode !== undefined ? { permissionMode: req.payload.permissionMode } : {}),
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
        // ADR-0005 W4: the in-process engine owns the resume on BOTH flavors
        // (claim + execute + continuation frames). The DO handoff is gone.
        const service = yield* AssistantService;
        const frames = yield* service.resumeChatStream(req.path.chatId, identity.userId);
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
        // ADR-0005 W3: the in-process task lane owns the resume (claim +
        // execute + continuation frames). No DO `resumeBatch` RPC.
        const frames = yield* service.resumeThreadStream(req.path.documentType, req.path.documentId);
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
        // ADR-0005 W4: D1 `assistant_threads.messages` is the single canonical
        // store. The stored legacy shape is forward-converted to UIMessage
        // parts; approvals reconciliation covers the carrier part and the legacy
        // `pendingBatch` field alike, so the decision endpoints stay untouched.
        const rawMessages = convertStoredMessages(t.messages as LegacyStoredMessage[]);
        const messages = yield* service.reconcileChatApprovals(rawMessages);
        return {
          chatId: t.documentId,
          projectId: t.projectId,
          ownerUserId: t.ownerUserId,
          agentId: t.agentId,
          skillId: t.skillId,
          messages,
          summary: t.summary,
          summarizedCount: t.summarizedCount,
          permissionMode: t.permissionMode ?? "ask",
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
    // Delegated run card access (ADR-0004 §3). The run is meaningful only
    // through its thread, but the card reads it directly: load the durable row,
    // gate on its project, then serve the persisted columns. The live event log
    // is never served here — it is session-memory only.
    .handle("getAssistantRun", (req) =>
      respond(Effect.gen(function* () {
        const db = yield* Db;
        const run = yield* getAssistantRunById(db, req.path.runId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantRunNotFound({ id: req.path.runId }))
        );
        yield* requireRunProjectRead(run.projectId, run.id);
        return run;
      }))
    )
    .handle("abortAssistantRun", (req) =>
      respond(Effect.gen(function* () {
        const db = yield* Db;
        const run = yield* getAssistantRunById(db, req.path.runId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantRunNotFound({ id: req.path.runId }))
        );
        yield* requireRunProjectRead(run.projectId, run.id);
        // ADR-0005 W4: the delegated-run DO facet is retired (D3). There is no
        // DO to abort; the registry row is admin-read-only/inert and the handler
        // acks so the client keeps its existing contract.
        return { ok: true as const };
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
              if (normalizeProviderKind(cfg.kind) !== "openai_compatible" && normalizeProviderKind(cfg.kind) !== "workers_ai") throw e;
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
        // Unsupported-wire ids (Google-wire `gemini*` on an OpenCode Zen/Go base)
        // are reported back but NEVER persisted.
        const skipped: Array<{ id: string; reason: string }> = [];
        const skippedIds = new Set<string>();
        for (const m of catalog.models) {
          const inferred = inferModelKindForProvider(m.id, prov.baseUrl);
          if (inferred === null) {
            skipped.push({ id: m.id, reason: "google wire" });
            skippedIds.add(m.id);
            continue;
          }
          const found = existingById.get(m.id);
          if (found) {
            const current = normalizeProviderKind(found.kind);
            // `inferModelKind` can never return `workers_ai` (a manual/legacy
            // kind with no catalog wire signature), so auto-correcting a
            // manually registered Workers AI row would silently flip it to
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
        // CF `ai/models/search` reports per-M token prices inline; persist them
        // so the call-log write can cost a turn. Best-effort: a price failure
        // must not fail the model import.
        const priceRepo = yield* AssistantModelPricesRepo;
        for (const m of catalog.models) {
          if (skippedIds.has(m.id)) continue;
          // Both prompt and completion prices are required before a row is
          // persisted: an input-only (or output-only) entry would upsert the
          // missing side as 0 and clobber a previously good price row.
          if (m.promptPrice === undefined || m.completionPrice === undefined) {
            continue;
          }
          yield* priceRepo
            .upsert({
              model: m.id,
              promptPrice: m.promptPrice ?? 0,
              completionPrice: m.completionPrice ?? 0,
              cachedReadPrice: m.cachedReadPrice ?? 0,
              cachedWritePrice: m.cachedWritePrice ?? 0,
            })
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() =>
                  assistantLog("WARN", "assistant model price persist failed", {
                    providerId: req.path.id,
                    modelId: m.id,
                    error: e instanceof Error ? e.message : String(e),
                  })
                )
              )
            );
        }
        const fresh = yield* mRepo.listByProvider(req.path.id);
        return { data: fresh, skipped };
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

// ── Assistant service layer (both flavors, ADR-0005 D7) ─────────────────
// Engine, gateway, MCP bridge, and the assistant-only repos/services. Now
// mounted on the Bun host too (the in-process tier runs on both flavors), so
// this layer is `agents`-free — only TanStack AI. `AssistantCatalogService`
// stays in the base layer — the agents/skills catalog survives on both flavors.

export function assistantServiceLayerWithStorage(
  storageCfg: StorageConfigShape,
  mcpConnector?: Layer.Layer<McpConnector>
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
  );
}

const storageLayerFor = (cfg: StorageConfigShape) =>
  Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg)));

const apiLayer = HttpApiBuilder.api(LexaApi);

// Full route groups (both flavors): the base groups plus the assistant lives.
// Exported so the Bun host composes the same set.
export function fullRouteGroups() {
  return Layer.mergeAll(
    baseRouteGroups(),
    assistantLive, adminAssistantLive, projectAssistantUsageLive, assistantMcpLive, assistantJevLive, assistantSchedulesLive
  );
}

// ─── Workers-side factory ───────────────────────────────────────────────
// Same route groups as the Bun host plus the assistant tier, composed over a
// caller-supplied DbDriver (D1 on Workers) with per-request env, R2 storage,
// and a per-request better-auth instance. The webhook stays outside this app
// (raw-body HMAC before parse — workers-entry.ts owns it).

export interface WorkersApiHandlerOptions {
  driver: DbDriver;
  runtimeEnv: RuntimeEnv;
  storage: StorageConfigShape;
  authHooks: ApiAuthHooksShape;
  getSession?: ((headers: Headers) => Promise<MiddlewareSession | null>) | undefined;
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
    assistantServiceLayerWithStorage(storage, opts.mcpConnector),
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

// ─── Bun-host factory including the assistant (tests) ───────────────────
// The Bearer-key assistant suites need a full-surface handler over a local
// sqlite file (better-auth singleton, env-resolved storage). Production Bun now
// mounts the assistant too (`createApiHandler` → `buildBunApp`), but this
// factory keeps the singleton-auth test shape the suites rely on.

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
