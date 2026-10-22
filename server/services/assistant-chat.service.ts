import { Cause, Effect } from "effect";
import { buildAssistantTools, MAX_CHAT_TOOL_ROUNDS, type BoundSkill } from "../assistant/tools";
import { buildPreflightState, jevLog, runJevPreflight, type JevPreflightResult, type JevRuntimeConfig } from "../assistant/jev";
import { acquireMcpToolset, buildMcpTools, ENABLED_MCP_SERVERS_SQL, type McpToolset } from "../assistant/mcp";
import type { McpServerRowWithSecret } from "../repos/assistant-mcp.repo";
import type { RuntimeEnv } from "../env";
import { currentEnv } from "../runtime-env";
import { buildSystemPrompts, extractMemoryTerms, memoryBlockFromHits, CHAT_IDENTITY } from "../assistant/prompt";
import { AssistantSettingsRepo, type AssistantSettingsRow } from "../repos/assistant-settings.repo";
import { AssistantThreadRepo } from "../repos/assistant-thread.repo";
import { AssistantPendingWritesRepo, type AssistantPendingWriteRow } from "../repos/assistant-pending-writes.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage } from "../storage/storage";
import { Db, DbError, RowNotFound, queryFirst, run, type SqlParam } from "../db/db";
import { AssistantGateway } from "../assistant/gateway.service";
import { AssistantJevService } from "./assistant-jev.service";
import { ProviderNotConfigured, VisionNotConfigured, InvalidArgs, AssistantThreadNotFound, AssistantTaskActive, ApprovalsPending, ApprovalNotFound, ApprovalAlreadyDecided, ApprovalExpired, ChatAttachmentsDisabled, AttachmentExtractionFailed, errorCodeMap } from "../api/errors";
import { isChatImageMime } from "../storage/mime";
import { chatAttachmentsEnabled } from "../capabilities";
import { buildAssistantWriteTools, createWriteRecorder, createLocalWriteTracker, parseWriteTools, buildAutoWriteRecord, buildDenyWriteRecord, type AssistantWriteToolDeps, type LocalWriteTracker, type QueuedProposal } from "../assistant/write-tools";
import { applyAssistantWrite, executeAssistantWrite } from "../assistant/write-execution";
import { TaskService } from "./task.service";
import { CommentService } from "./comment.service";
import { WikiService } from "./wiki.service";
import { MilestoneService } from "./milestone.service";
import { SwimlaneService } from "./swimlane.service";
import { AuthorizationService } from "./authorization.service";
import { buildSkillPromptParts, lastUserText, resolveMentionContextEffect, type MentionResolverDeps } from "../assistant/context";
import type { AssistantChatStreamRequest, AssistantReasoningEffort, AssistantToolPermissionMode, Citation, StreamFrame } from "../../shared/assistant";
import { resolveAssistantToolPermissionMode } from "../../shared/assistant";
import { buildStream, findPendingBatch, findPendingBatches, findNewestPendingBatch, applyResumeResults, reconcilePendingBatchStatuses, buildResumeResultsNote } from "../assistant/build-stream";
import { claimResumeBatch, releaseResumeBatch } from "../assistant/resume-claim";
import { carrierBatchIds, reconcileApprovalCarriers } from "../assistant/approval-carrier";
import { collectResumeResults, resumeOutcomeLog, stoppedResumeEntry, targetOf, type ResumeResult } from "../assistant/resume-results";
import { resolveAssistantThread, resolveChatTitle, collectCitation, CHAT_CITATION_CAP, assertChatAttachmentCaps, extractDocumentText, resolveReasoningEffort, modelOptionsForTurn, modelOptionsWithWriteIntent, bytesToBase64, buildChatSnippet, validateChatFromIndex, matchBoundSkillByName, BOUND_SKILLS_SQL } from "./assistant-helpers";
import { buildAnalyzeImageTool, resolveVisionMode } from "../assistant/vision";
import type { ProviderConfig } from "../assistant/provider";
import { AssistantProvidersService } from "./assistant-providers.service";
import { activeChats, tryAcquireChat, releaseChat } from "../assistant/active-chats";

function bindRequestAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
export class AssistantChatService extends Effect.Service<AssistantChatService>()("Lexa/AssistantChatService", {
  dependencies: [AssistantSettingsRepo.Default, AssistantThreadRepo.Default, AssistantPendingWritesRepo.Default, ProjectMemoryRepo.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default, AssistantGateway.Default, AssistantJevService.Default, AssistantProvidersService.Default, TaskService.Default, CommentService.Default, WikiService.Default, MilestoneService.Default, SwimlaneService.Default, AuthorizationService.Default],
  effect: Effect.gen(function* () {
    const settingsRepo = yield* AssistantSettingsRepo;
    const threadRepo = yield* AssistantThreadRepo;
    const pendingWritesRepo = yield* AssistantPendingWritesRepo;
    const memoryRepo = yield* ProjectMemoryRepo;
    const storage = yield* Storage;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const db = yield* Db;
    const dbFirst = <T>(sql: string, ...params: SqlParam[]): Promise<T | null> =>
      db.prepare(sql).first(...params).then((row) => row as unknown as T | null);
    const dbAll = <T>(sql: string, ...params: SqlParam[]): Promise<T[]> =>
      db.prepare(sql).all(...params).then((rows) => rows as unknown as T[]);
    // A duplicate / no-op resume must not re-execute the batch, but it IS a
    // settled outcome: emit a terminal `done` so the client persists the batch
    // instead of reading an empty stream as a stall and retrying forever.
    const emptyFrameStream = (): ReadableStream<StreamFrame> =>
      new ReadableStream<StreamFrame>({
        start(controller) {
          controller.enqueue({ type: "done", text: "", usage: { in: 0, out: 0 } });
          controller.close();
        },
      });
    const gateway = yield* AssistantGateway;
    const jevService = yield* AssistantJevService;
    const providersService = yield* AssistantProvidersService;
    const taskService = yield* TaskService;
    const commentService = yield* CommentService;
    const wikiService = yield* WikiService;
    const milestoneService = yield* MilestoneService;
    const swimlaneService = yield* SwimlaneService;
    const authz = yield* AuthorizationService;

    // Read-only MCP tools for this project: globally + project enabled servers,
    // discovered fail-open. Undefined when the project has none.
    const loadAssistantMcp = (projectId: string, allowlist: string | null, register: (toolset: McpToolset | undefined) => void): Effect.Effect<McpToolset | undefined> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const servers = yield* Effect.tryPromise({
          try: () => dbAll<McpServerRowWithSecret>(ENABLED_MCP_SERVERS_SQL, projectId),
          catch: () => new DbError({ message: "failed to load enabled MCP servers" }),
        }).pipe(Effect.catchAll(() => Effect.succeed([] as McpServerRowWithSecret[])));
        if (servers.length === 0) return undefined;
        return yield* acquireMcpToolset(() => buildMcpTools({ servers, projectId, env, allowlist }).catch(() => undefined), register);
      });

    const configFromRow = (row: AssistantSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { model: string }).model ?? "" });
    // Vision agent config, resolved from the registry exactly like the Worker
    // path: `assistant_settings.provider_id` → the provider's base URL + the
    // model row's kind, with the key opened through the providers service. The
    // legacy per-project kind/base_url/api_key columns were dropped in 0008, so
    // reading them yielded an empty base URL ("Invalid URL"). Null when the
    // binding is absent or unresolvable.
    const visionConfigOf = (row: AssistantSettingsRow): Effect.Effect<ProviderConfig | null> => Effect.gen(function* () {
      const providerId = (row as unknown as { provider_id: string | null }).provider_id;
      const visionModel = (row as unknown as { vision_model: string | null }).vision_model;
      if (providerId === null || providerId === "" || visionModel === null || visionModel === "") return null;
      const modelRow = yield* Effect.promise(() => dbFirst<{ kind: ProviderConfig["kind"] }>(`SELECT kind FROM assistant_models WHERE provider_id = ? AND model_id = ? AND enabled = 1 LIMIT 1`, providerId, visionModel));
      if (modelRow === null) return null;
      const providerRow = yield* Effect.promise(() => dbFirst<{ base_url: string }>(`SELECT base_url FROM assistant_providers WHERE id = ?`, providerId));
      if (providerRow === null) return null;
      const apiKey = yield* providersService.resolveApiKey(providerId).pipe(Effect.catchAll(() => Effect.succeed("")));
      return { kind: modelRow.kind, baseUrl: providerRow.base_url, apiKey, model: visionModel };
    });
    const resolveMimeType = async (projectId: string, chatId: string, userId: string, key: string): Promise<string> =>
      (await dbFirst<{ mime_type: string }>(
        `SELECT ca.mime_type FROM chat_attachments ca
         JOIN assistant_threads t ON t.document_type = 'chat' AND t.document_id = ca.document_id
           AND t.project_id = ca.project_id AND t.owner_user_id = ?
         WHERE ca.project_id = ? AND ca.document_type = 'chat' AND ca.document_id = ? AND ca.storage_key = ? LIMIT 1`,
        userId, projectId, chatId, key
      ))?.mime_type ??
      (await dbFirst<{ mime_type: string }>(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key))?.mime_type ??
      "image/png";
    const loadBoundSkills = (agentId: string): Promise<BoundSkill[]> => dbAll<BoundSkill>(BOUND_SKILLS_SQL, agentId);
    const getSettingsOrFail = (projectId: string) => settingsRepo.getByProject(projectId).pipe(Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId })));
    // Private chat blobs require the owning thread; project attachments remain project-scoped.
    const ownsImageStorageKey = async (projectId: string, chatId: string, userId: string, key: string): Promise<boolean> =>
      (await dbFirst(
        `SELECT 1 FROM chat_attachments ca
         JOIN assistant_threads t ON t.document_type = 'chat' AND t.document_id = ca.document_id
           AND t.project_id = ca.project_id AND t.owner_user_id = ?
         WHERE ca.project_id = ? AND ca.document_type = 'chat' AND ca.document_id = ? AND ca.storage_key = ? LIMIT 1`,
        userId, projectId, chatId, key
      )) !== null ||
      (await dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key)) !== null;
    const loadImageBase64For = (projectId: string, chatId: string, userId: string) => async (key: string): Promise<string | null> => {
      if (!(await ownsImageStorageKey(projectId, chatId, userId, key))) return null;
      return Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);
    };
    // History refs may resolve either thread-owned chat uploads or project attachments.
    // Fresh cache per loader keeps extraction run-scoped and memory bounded.
    const makeDocumentTextLoader = (projectId: string, chatId: string, userId: string, binding?: RuntimeEnv["AI"]): ((key: string) => Promise<string | null>) => {
      const cache = new Map<string, string | null>();
      return async (key: string): Promise<string | null> => {
        if (cache.has(key)) return cache.get(key) ?? null;
        const row =
          (await dbFirst<{ filename: string; mime_type: string }>(
            `SELECT ca.filename, ca.mime_type FROM chat_attachments ca
             JOIN assistant_threads t ON t.document_type = 'chat' AND t.document_id = ca.document_id
               AND t.project_id = ca.project_id AND t.owner_user_id = ?
             WHERE ca.project_id = ? AND ca.document_type = 'chat' AND ca.document_id = ? AND ca.storage_key = ? LIMIT 1`,
            userId, projectId, chatId, key
          )) ??
          (await dbFirst<{ filename: string; mime_type: string }>(`SELECT filename, mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key));
        if (!row) { cache.set(key, null); return null; }
        const bytes = await Effect.runPromise(storage.get(key)).catch(() => null);
        if (!bytes) { cache.set(key, null); return null; }
        const text = await extractDocumentText(bytes, row.mime_type, row.filename, binding);
        const value = text !== null && text.trim() !== "" ? text : null;
        cache.set(key, value);
        return value;
      };
    };
    // Shared @-mention resolver over the service's repos. RowNotFound maps to
    // `null` (a miss); any other error throws so the shared resolver's control
    // flow matches the previous in-service Effect version exactly.
    const mentionDeps: MentionResolverDeps = {
      dbAll: <T>(sql: string, ...params: unknown[]) => dbAll<T>(sql, ...(params as SqlParam[])),
      findTaskByKey: async (key) => {
        const outcome = await Effect.runPromise(Effect.either(taskRepo.findByKey(key)));
        if (outcome._tag === "Left") {
          if (outcome.left._tag === "RowNotFound") return null;
          throw outcome.left;
        }
        return { id: outcome.right.id, projectId: outcome.right.projectId, key: outcome.right.key, title: outcome.right.title, description: outcome.right.description };
      },
      findWikiBySlug: async (projectId, slug) => {
        const outcome = await Effect.runPromise(Effect.either(wikiRepo.findBySlug(projectId, slug)));
        if (outcome._tag === "Left") {
          if (outcome.left._tag === "RowNotFound") return null;
          throw outcome.left;
        }
        return { id: outcome.right.id, title: outcome.right.title, content: outcome.right.content };
      },
    };
    // Current-turn refs are accepted only from this owner's uploads on this thread.
    const validateAttachments = (projectId: string, chatId: string, userId: string, attachments: ReadonlyArray<{ storageKey: string; mimeType: string; name: string }>): Effect.Effect<void, InvalidArgs | DbError> => Effect.gen(function* () {
      const sized: Array<{ mimeType: string; size: number; name: string }> = [];
      for (const a of attachments) {
        const row = yield* Effect.promise(() => dbFirst<{ mime_type: string; size_bytes: number; filename: string }>(
          `SELECT ca.mime_type, ca.size_bytes, ca.filename FROM chat_attachments ca
           JOIN assistant_threads t ON t.document_type = 'chat' AND t.document_id = ca.document_id
             AND t.project_id = ca.project_id AND t.owner_user_id = ?
           WHERE ca.project_id = ? AND ca.document_type = 'chat' AND ca.document_id = ? AND ca.storage_key = ? LIMIT 1`,
          userId, projectId, chatId, a.storageKey
        ));
        if (!row) return yield* new InvalidArgs({ reason: `attachment '${a.name}' does not belong to this chat` });
        if (a.mimeType !== row.mime_type) return yield* new InvalidArgs({ reason: `attachment '${a.name}' mimeType mismatch` });
        sized.push({ mimeType: row.mime_type, size: row.size_bytes, name: row.filename });
      }
      yield* Effect.try({ try: () => assertChatAttachmentCaps(sized), catch: (e) => e as InvalidArgs });
    });
    // Jev preflight. Advisory and fail-open by contract: any outcome other than
    // a rendered segment leaves the run untouched, and the catch below keeps
    // even a thrown helper from reaching the stream.
    const runPreflight = (config: JevRuntimeConfig | null, input: Parameters<typeof buildPreflightState>[0]): Effect.Effect<JevPreflightResult, never> => {
      // A null config is the disable switch: no request is attempted, and the
      // outcome is the documented skip rather than a per-run failure.
      if (config === null) {
        return Effect.succeed<JevPreflightResult>({ segment: null, outcome: "skipped", code: "MISSING_KEY", latencyMs: 0 });
      }
      return Effect.tryPromise(() => runJevPreflight({ state: buildPreflightState(input), config })).pipe(
        Effect.catchAll(() => Effect.succeed<JevPreflightResult>({ segment: null, outcome: "failed", code: "NETWORK", latencyMs: 0 })),
        // An unconfigured Jev is a deployment state, not a per-run event, so
        // its outcome stands but the log line is dropped: one INFO per run for
        // every chat on an instance that never asked for it is pure noise.
        Effect.tap((result) => Effect.sync(() => {
          if (result.code !== "MISSING_KEY") jevLog("preflight", result);
        }))
      );
    };

    const buildToolDeps = (projectId: string, allowlist: string | null, searchApiKey: string | null, jevConfig: JevRuntimeConfig | null, boundSkills: BoundSkill[], markdownBinding?: RuntimeEnv["AI"]) => ({
      projectId, allowlist, searchApiKey, jevConfig, fetchImpl: fetch, markdownBinding,
      // get_skill can only discover skills the agent actually has bound, so the
      // loader (and with it the tool) is omitted when there are none.
      ...(boundSkills.length > 0 ? { loadSkillByName: async (name: string): Promise<BoundSkill | null> => matchBoundSkillByName(boundSkills, name) } : {}),
      storageGet: (key: string) => Effect.runPromise(storage.get(key)),
      projectOwnsStorageKey: (pid: string, key: string) => dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, pid, key).then((r) => r !== null),
      resolveStorageFile: async (pid: string, key: string) => {
        const row = await dbFirst<{ filename: string; mime_type: string }>(`SELECT filename, mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, pid, key);
        return row ? { filename: row.filename, mimeType: row.mime_type } : null;
      },
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || t.projectId !== projectId) return null;
        const [col, lane] = await Promise.all([
          dbFirst<{ name: string }>(`SELECT name FROM columns WHERE id = ?`, t.columnId),
          dbFirst<{ name: string; milestone_id: string | null }>(`SELECT name, milestone_id FROM swimlanes WHERE id = ?`, t.swimlaneId),
        ]);
        let milestoneName: string | null = null;
        if (lane?.milestone_id) { const m = await dbFirst<{ name: string }>(`SELECT name FROM milestones WHERE id = ?`, lane.milestone_id); milestoneName = m?.name ?? null; }
        return { id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: t.description, columnName: col?.name ?? "", swimlaneName: lane?.name ?? "", milestoneName, type: t.type, assignees: t.assignees, githubIssue: null };
      },
      searchTasksByTitle: async (query: string, limit = 10) => { const rows = await Effect.runPromise(taskRepo.searchByTitle(projectId, query, limit)).catch(() => []); return rows.map((t) => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: t.description })); },
      searchWikiPages: async (query: string, limit = 10) => { const rows = await Effect.runPromise(wikiRepo.search(projectId, query, limit)).catch(() => []); return rows.map((p) => ({ title: p.title, slug: p.slug, snippet: p.snippet })); },
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); return page ? { title: page.title, slug: page.slug, content: page.content } : null; },
      listAllTasks: async () => { const rows = await Effect.runPromise(taskRepo.listByProject(projectId)).catch(() => []); return rows.map((t) => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: t.description })); },
      listWikiPagesFull: async () => { const rows = await Effect.runPromise(wikiRepo.findFullByProject(projectId)).catch(() => []); return rows.map((p) => ({ title: p.title, slug: p.slug, content: p.content })); },
      getBoardStructure: async () => {
        const columns = (await dbAll<{ id: string; name: string; position: number; wip_limit: number | null; github_state: "open" | "closed" | null; is_done: number }>(`SELECT id, name, position, wip_limit, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`, projectId)).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wip_limit, githubState: c.github_state, isDone: c.is_done !== 0 }));
        const swimlanes = (await dbAll<{ id: string; name: string; kind: "backlog" | "sprint"; start_at: string | null; due_at: string | null; archived_at: string | null; milestone_id: string | null }>(`SELECT id, name, kind, start_at, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`, projectId)).map((l) => ({ id: l.id, name: l.name, kind: l.kind, startAt: l.start_at, dueAt: l.due_at, archived: l.archived_at !== null, milestoneId: l.milestone_id }));
        const milestones = (await dbAll<{ id: string; name: string; due_at: string | null; archived_at: string | null }>(`SELECT id, name, due_at, archived_at FROM milestones WHERE project_id = ? ORDER BY position`, projectId)).map((m) => ({ id: m.id, name: m.name, dueAt: m.due_at, archived: m.archived_at !== null }));
        return { columns, swimlanes, milestones };
      },
    });
    const makeWriteDeps = (projectId: string, record: AssistantWriteToolDeps["record"], localWriteTracker: LocalWriteTracker): AssistantWriteToolDeps => ({
      projectId,
      localWriteTracker,
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || t.projectId !== projectId) return null;
        const col = await dbFirst<{ name: string }>(`SELECT name FROM columns WHERE id = ?`, t.columnId);
        return { id: t.id, key: t.key, title: t.title, columnName: col?.name ?? "", priority: t.priority, type: t.type, dueAt: t.dueAt, assignees: t.assignees, description: t.description, archivedAt: t.archivedAt };
      },
      findColumn: async (id: string) => (await dbFirst<{ id: string; name: string }>(`SELECT id, name FROM columns WHERE id = ?`, id)) ?? null,
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); return page ? { slug: page.slug, title: page.title, text: page.content } : null; },
      findMilestone: async (id: string) => { const m = await dbFirst<{ id: string; name: string; due_at: string | null; archived_at: string | null }>(`SELECT id, name, due_at, archived_at FROM milestones WHERE id = ?`, id); return m ? { id: m.id, name: m.name, dueAt: m.due_at, archivedAt: m.archived_at } : null; },
      findSwimlane: async (id: string) => { const l = await dbFirst<{ id: string; name: string; kind: "backlog" | "milestone" | "sprint"; archived_at: string | null; milestone_id: string | null }>(`SELECT id, name, kind, archived_at, milestone_id FROM swimlanes WHERE id = ?`, id); return l ? { id: l.id, name: l.name, kind: l.kind, archivedAt: l.archived_at, milestoneId: l.milestone_id } : null; },
      countSprints: async (milestoneId) => { const r = await dbFirst<{ c: number }>(`SELECT COUNT(*) AS c FROM swimlanes WHERE milestone_id = ? AND kind = 'sprint' AND archived_at IS NULL`, milestoneId); return r?.c ?? 0; },
      record,
    });
    // Write-execution deps for the auto path (ADR-0005 §Port P1). The pending
    // row is a row concern, not an apply concern, so it is omitted here.
    const applyCtx = { db, taskService, commentService, wikiService, milestoneService, swimlaneService, authz, taskRepo, wikiRepo };
    // Mode-aware write toolset (ADR-0005 §Port P1): `ask` records pending rows
    // and returns a drain (build-stream suspends); `auto` applies each write
    // in-loop via `applyAssistantWrite` with a per-turn budget (no pending row,
    // no drain, no suspend); `deny` refuses locally (no drain). The enabled-name
    // filter is shared by all modes.
    const buildWriteToolset = (settingsRow: AssistantSettingsRow, turn: { projectId: string; documentType: "task" | "wiki" | "chat"; documentId: string; ownerUserId: string }, mode: AssistantToolPermissionMode, localWriteTracker: LocalWriteTracker): { tools: unknown[]; drain: (() => QueuedProposal[]) | undefined } => {
      const enabled = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
      if (enabled.length === 0) return { tools: [], drain: undefined };
      let drain: (() => QueuedProposal[]) | undefined;
      let record: AssistantWriteToolDeps["record"];
      if (mode === "deny") {
        record = buildDenyWriteRecord();
      } else if (mode === "auto") {
        record = buildAutoWriteRecord({
          apply: async (toolName, args) => {
            const outcome = await Effect.runPromise(Effect.either(applyAssistantWrite({ toolName, args, projectId: turn.projectId, ownerUserId: turn.ownerUserId }, applyCtx)));
            if (outcome._tag === "Left") {
              const e = outcome.left as { _tag?: string; message?: string };
              return { ok: false, error: `${errorCodeMap[e._tag ?? ""] ?? "ASSISTANT_WRITE_FAILED"}: ${String(e.message ?? "write failed")}`.slice(0, 2000) };
            }
            return { ok: true, result: outcome.right };
          },
        });
      } else {
        const recorder = createWriteRecorder(turn, (row) => Effect.runPromise(pendingWritesRepo.insert({ id: row.id, project_id: row.projectId, document_type: row.documentType, document_id: row.documentId, owner_user_id: row.ownerUserId, batch_id: row.batchId, seq: row.seq, tool_name: row.toolName, args: row.args, diff: row.diff, expires_at: row.expiresAt })).then(() => {}));
        record = recorder.record;
        drain = () => recorder.drain();
      }
      const all = buildAssistantWriteTools(makeWriteDeps(turn.projectId, record, localWriteTracker)) as Array<{ name: string }>;
      const enabledSet = new Set(enabled);
      const tools = all.filter((t) => enabledSet.has(t.name));
      return tools.length === 0 ? { tools: [], drain: undefined } : { tools, drain };
    };

    return {
      activeChats,
      MAX_CHAT_TOOL_ROUNDS,
      abortChat: (chatId: string): boolean => { activeChats.get(chatId)?.abort(); return activeChats.has(chatId); },
      chatActive: (chatId: string): boolean => activeChats.has(chatId),
      // Transcript-read reconciliation: attach the live decision status of
      // every persisted pending batch so another tab's decisions render as
      // terminal chips here on fetch (no batch-read endpoint — the markers
      // already carry the approval ids). A thread can hold more than one
      // marker, so reconcile them all, not just the newest.
      reconcileChatApprovals: (messages: unknown[]) => Effect.gen(function* () {
        // W7b/WS2: reconcile BOTH the legacy `pendingBatch` field and the D3
        // `data-assistant-approval` carrier parts against the live decision
        // rows, so a parts-shaped transcript rebuilt on reload shows each
        // approval's live status and a marker-only carrier is backfilled from
        // its rows. A thread can hold several markers/batches.
        const batchIds = findPendingBatches(messages);
        for (const id of carrierBatchIds(messages)) {
          if (!batchIds.includes(id)) batchIds.push(id);
        }
        if (batchIds.length === 0) return messages;
        const batches = yield* Effect.forEach(batchIds, (batchId) =>
          pendingWritesRepo.listByBatch(batchId).pipe(Effect.catchAll(() => Effect.succeed([] as AssistantPendingWriteRow[])))
        );
        const rows = batches.flat();
        if (rows.length === 0) return messages;
        const parseDiff = (raw: string): unknown => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        };
        const decisionRows = rows.map((r) => {
          const diff = parseDiff(r.diff);
          return {
            id: r.id,
            batchId: r.batch_id,
            status: r.status,
            seq: r.seq,
            name: r.tool_name,
            ...(diff !== undefined ? { diff } : {}),
            ...(r.proposed_by_run_id ? { proposedByRunId: r.proposed_by_run_id } : {}),
            ...(r.execution_error ? { executionError: r.execution_error } : {}),
          };
        });
        const legacyReconciled = reconcilePendingBatchStatuses(messages, decisionRows);
        return reconcileApprovalCarriers(legacyReconciled, decisionRows);
      }),
      listChats: (projectId: string, userId: string, opts: { q?: string | undefined } = {}) =>
        pendingWritesRepo.sweepExpired().pipe(
          Effect.flatMap(() => threadRepo.listChats(projectId, userId, { ...(opts.q !== undefined ? { q: opts.q } : {}) })),
          Effect.catchAll(() => threadRepo.listChats(projectId, userId, { ...(opts.q !== undefined ? { q: opts.q } : {}) })),
          Effect.map((rows) => rows.map((t) => ({ chatId: t.documentId, title: t.title, pinned: t.pinned, snippet: opts.q ? buildChatSnippet(t.messages, opts.q) : null, createdAt: t.createdAt, updatedAt: t.updatedAt })))
        ),
      updateChatMeta: (chatId: string, userId: string, patch: { title?: string; pinned?: boolean }) => Effect.gen(function* () {
        const next: { title?: string; pinned?: boolean } = {};
        if (patch.title !== undefined) { const trimmed = patch.title.trim(); if (trimmed === "" || trimmed.length > 200) return yield* new InvalidArgs({ reason: "title must be 1-200 characters" }); next.title = trimmed; }
        if (patch.pinned !== undefined) next.pinned = patch.pinned;
        if (next.title === undefined && next.pinned === undefined) return yield* new InvalidArgs({ reason: "nothing to update — provide title or pinned" });
        return yield* threadRepo.updateChatMeta(chatId, userId, next);
      }),
      runChatStream: (chatId: string, userId: string, req: AssistantChatStreamRequest, requestSignal?: AbortSignal) => Effect.gen(function* () {
        if (!tryAcquireChat(chatId)) return yield* new AssistantTaskActive();
        const controller = activeChats.get(chatId)!;
        const detachRequestAbort = bindRequestAbort(requestSignal, controller);
        const release = () => { detachRequestAbort(); releaseChat(chatId, controller); };
        let mcp: McpToolset | undefined = undefined;
        return yield* Effect.gen(function* () {
        const settingsRow = yield* getSettingsOrFail(req.projectId);
        const config = configFromRow(settingsRow);
        const env = yield* currentEnv;
        const loadDocumentText = makeDocumentTextLoader(req.projectId, chatId, userId, env.AI);
        const attachments = req.attachments ?? [];
        const imageAttachments = attachments.filter((a) => isChatImageMime(a.mimeType));
        // Kill switch refuses sends carrying any attachment regardless of the
        // capability flag (D5).
        if (attachments.length > 0 && !chatAttachmentsEnabled(env)) return yield* new ChatAttachmentsDisabled();
        yield* validateAttachments(req.projectId, chatId, userId, attachments);
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        // Documents do not need vision; only image attachments gate on it.
        if (imageAttachments.length > 0 && imageMode === "none") return yield* new VisionNotConfigured();
        // Send-time extraction: a document whose bytes yield no text blocks the
        // send with a named error rather than being silently dropped (D3).
        for (const a of attachments) {
          if (isChatImageMime(a.mimeType)) continue;
          const text = yield* Effect.promise(() => loadDocumentText(a.storageKey));
          if (text === null) return yield* new AttachmentExtractionFailed({ filename: a.name, reason: "could not extract readable text" });
        }
        const mentionContext = yield* resolveMentionContextEffect(mentionDeps, req.projectId, req.message);
        const boundSkills = yield* Effect.promise(() => loadBoundSkills("assistant"));
        const { skillMarkdowns, skillCatalog } = buildSkillPromptParts(req.message, boundSkills);
        yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
        const existing = yield* threadRepo.claimChat(chatId, userId, req.projectId).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: chatId }))
        );
        if (existing.ownerUserId !== userId || existing.projectId !== req.projectId) return yield* new AssistantThreadNotFound({ documentType: "chat", documentId: chatId });
        // Turn-start mode capture (D2/D6): the send envelope overrides the
        // stored sticky value; the captured mode is persisted as the new sticky
        // value below and held constant for the whole turn (a mid-turn change
        // waits for the next send).
        const permissionMode = resolveAssistantToolPermissionMode(req.permissionMode, existing?.permissionMode ?? null);
        let verdict = resolveAssistantThread(existing, req.agentId ?? null);
        const title = resolveChatTitle(existing, req.message);
        if (req.fromIndex !== undefined) {
          const fromIndex = req.fromIndex;
          yield* Effect.try({ try: () => { validateChatFromIndex(verdict.messages, fromIndex); }, catch: (e) => e as InvalidArgs });
          if (fromIndex < verdict.messages.length) {
            const truncated = yield* threadRepo.truncateChatFrom(chatId, userId, fromIndex);
            verdict = resolveAssistantThread(truncated, req.agentId ?? null);
            const orphanBatch = findPendingBatch(verdict.messages);
            if (orphanBatch !== null) return yield* new ApprovalsPending({ batchId: orphanBatch, remaining: 0 });
          }
        }
        // Persist captured mode as thread's sticky value. Best-effort: write failure
        // must not abort turn; ownership was verified by claimChat above.
        yield* threadRepo.setPermissionMode("chat", chatId, permissionMode).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(req.projectId, extractMemoryTerms(req.message, ""));
        // Resolved ONCE for this run from the DB registry: global enabled +
        // project opt-in + stored, decryptable key. Total — null is the gate.
        const jevConfig = yield* jevService.resolveForProject(req.projectId);
        // Preflight runs once per NEW run, never on resume; only inputs this run
        // already loaded are serialized (no history, no attachments, no keys).
        const preflight = yield* runPreflight(jevConfig, {
          runKind: "chat",
          projectId: req.projectId,
          threadId: chatId,
          threadLabel: title,
          userMessage: req.message,
          taskWikiContext: mentionContext,
          memoryHits,
        });
        const systemPrompts = buildSystemPrompts({ identity: CHAT_IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: null, skillMarkdowns, skillCatalog, mentionContext, writeTools: enabledWriteTools, advisory: preflight.segment });
        const refs: unknown[] = attachments.map((a) => isChatImageMime(a.mimeType)
          ? { type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType }
          : { type: "document-ref", storageKey: a.storageKey, mimeType: a.mimeType, name: a.name });
        const userContent: string | unknown[] = refs.length > 0 ? [{ type: "text", content: req.message }, ...refs] : req.message;
        let citations: Citation[] = [];
        let chatWriteDrain: (() => QueuedProposal[]) | undefined;
        // `getSettingsOrFail` hands back the decoded settings view, not the raw
        // row; the reasoning-effort column is read off the row shape.
        const settingsEffort = (settingsRow as unknown as { reasoning_effort: AssistantReasoningEffort | null }).reasoning_effort;
        const baseModelOptions = modelOptionsForTurn(resolveReasoningEffort(settingsEffort, req.reasoningEffort), config.kind);
        const modelOptions = modelOptionsWithWriteIntent(baseModelOptions, req.message, enabledWriteTools);
        const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
        yield* loadAssistantMcp(req.projectId, allowlist, (toolset) => { mcp = toolset; });
        const visionConfig = imageMode === "delegate" && imageAttachments.length > 0 ? yield* visionConfigOf(settingsRow) : null;
        const localWriteTracker = createLocalWriteTracker();
        return buildStream({
          keyId: chatId, idField: "chatId", threadId: chatId, registry: activeChats, config, resolveCompactionConfig: () => Effect.runPromise(gateway.resolveProviderConfig(req.projectId)), gatewayStream: (input) => gateway.streamChat({ projectId: req.projectId, ...input }), localWriteTracker,
          systemPrompts, history: verdict.messages, userTs: new Date().toISOString(), getCitations: () => citations, modelOptions,
          userContent, tools: (() => {
            const base = buildAssistantTools({ ...buildToolDeps(req.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills, env.AI), onCitation: (c) => { citations = collectCitation(citations, c); } });
            const writeSet = buildWriteToolset(settingsRow, { projectId: req.projectId, documentType: "chat", documentId: chatId, ownerUserId: userId }, permissionMode, localWriteTracker);
            chatWriteDrain = writeSet.drain;
            const mcpTools = mcp?.tools ?? [];
            return visionConfig !== null ? [...base, buildAnalyzeImageTool({ config: { ...visionConfig, sessionId: chatId }, loadImageBase64: loadImageBase64For(req.projectId, chatId, userId), resolveMimeType: (key) => resolveMimeType(req.projectId, chatId, userId, key), fetchImpl: fetch }), ...writeSet.tools, ...mcpTools] : [...base, ...writeSet.tools, ...mcpTools];
          })(), toolRoundCap: MAX_CHAT_TOOL_ROUNDS, loadImageBase64: loadImageBase64For(req.projectId, chatId, userId), loadDocumentText, imageMode: imageAttachments.length > 0 ? imageMode : "inline", ...(chatWriteDrain ? { writeDrain: chatWriteDrain } : {}), writeTools: enabledWriteTools, writeMode: permissionMode, historySummary: () => verdict.summary, historySummarizedCount: () => verdict.summarizedCount, onDispose: async () => { try { if (mcp) await mcp.close(); } finally { release(); } },
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread("chat", chatId, { projectId: req.projectId, ownerUserId: userId, title, agentId: req.agentId ?? null, skillId: null, messages, summary, summarizedCount })).then(() => {}),
          onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
        });
        }).pipe(Effect.onError(() => Effect.promise(async () => {
          try { if (mcp) await mcp.close(); } catch {}
          finally { release(); }
        })));
      }),
      decideApproval: (approvalId: string, userId: string, verdict: "approve" | "reject") => Effect.gen(function* () {
        yield* pendingWritesRepo.sweepExpired();
        const row = yield* pendingWritesRepo.getById(approvalId);
        if (row === null || row.owner_user_id !== userId) return yield* new ApprovalNotFound({ id: approvalId });
        const expired = yield* pendingWritesRepo.expireIfDue(approvalId);
        if (expired !== null) return yield* new ApprovalExpired({ id: approvalId });
        if (row.status !== "pending") return yield* new ApprovalAlreadyDecided({ id: approvalId, status: row.status });
        const decided = yield* pendingWritesRepo.decide(approvalId, verdict === "approve" ? "approved" : "rejected");
        const remaining = yield* pendingWritesRepo.countByBatchRemaining(row.batch_id);
        return { approvalId, batchId: row.batch_id, status: decided?.status ?? row.status, remaining };
      }),
      resumeChatStream: (chatId: string, userId: string, requestedBatchId?: string, requestSignal?: AbortSignal) => Effect.gen(function* () {
        if (!tryAcquireChat(chatId)) return yield* new AssistantTaskActive();
        const controller = activeChats.get(chatId)!;
        const detachRequestAbort = bindRequestAbort(requestSignal, controller);
        const release = () => { detachRequestAbort(); releaseChat(chatId, controller); };
        let mcp: McpToolset | undefined = undefined;
        let ownedClaim: string | undefined;
        let executionStarted = false;
        let executingRow: AssistantPendingWriteRow | undefined;
        let progressResults: ResumeResult[] = [];
        let progressLines: Parameters<typeof buildResumeResultsNote>[0] = [];
        let persistResumeOutcome: ((stopped: boolean) => Promise<void>) | undefined;
        const releaseUnusedClaim = () => Effect.uninterruptible(Effect.gen(function* () {
          if (ownedClaim !== undefined && !executionStarted) {
            yield* releaseResumeBatch(db, ownedClaim);
            ownedClaim = undefined;
          }
        }));
        return yield* Effect.gen(function* () {
          const env = yield* currentEnv;
          yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
          const thread = yield* threadRepo.loadChat(chatId, userId).pipe(Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType: "chat", documentId: chatId })));
          const loadDocumentText = makeDocumentTextLoader(thread.projectId, chatId, userId, env.AI);
          const settingsRow = yield* getSettingsOrFail(thread.projectId);
          yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
          const batchId = requestedBatchId ?? findNewestPendingBatch(thread.messages);
          if (batchId === null) return yield* new ApprovalsPending({ batchId: "", remaining: 0 });
          if (requestedBatchId !== undefined && !findPendingBatches(thread.messages).includes(requestedBatchId) && !carrierBatchIds(thread.messages).includes(requestedBatchId)) {
            return yield* new ApprovalNotFound({ id: requestedBatchId });
          }
          const rows = yield* pendingWritesRepo.listByBatch(batchId);
          if (rows.some((row) => row.project_id !== thread.projectId || row.document_type !== "chat" || row.document_id !== chatId || row.owner_user_id !== userId)) {
            return yield* new ApprovalNotFound({ id: batchId });
          }
          const claim = yield* Effect.uninterruptible(Effect.gen(function* () {
            const outcome = yield* claimResumeBatch(db, batchId);
            if (outcome === "claimed") ownedClaim = batchId;
            return outcome;
          }));
          if (claim === "duplicate") {
            release();
            return emptyFrameStream();
          }
          const remaining = rows.filter((r) => r.status === "pending").length;
          if (remaining > 0) {
            yield* releaseUnusedClaim();
            return yield* new ApprovalsPending({ batchId, remaining });
          }
          if (rows.length === 0) {
            yield* releaseUnusedClaim();
            release();
            return emptyFrameStream();
          }
          const ctx = { db, taskService, commentService, wikiService, milestoneService, swimlaneService, authz, pendingWritesRepo, taskRepo, wikiRepo };
          persistResumeOutcome = async (stopped) => {
            const messages = executionStarted ? applyResumeResults(thread.messages, [batchId]) : thread.messages;
            const indeterminate = executingRow !== undefined && !progressResults.some((result) => result.approvalId === executingRow!.id)
              ? { tool: executingRow.tool_name, target: targetOf(executingRow) } : undefined;
            const entry = stoppedResumeEntry(progressLines, indeterminate);
            const { stopped: _stopped, ...outcomeEntry } = entry;
            const terminal = stopped ? entry : { ...outcomeEntry, error: { code: "ASSISTANT_GENERATION_FAILED", message: "Assistant generation failed" } };
            await Effect.runPromise(threadRepo.saveThread("chat", chatId, { projectId: thread.projectId, ownerUserId: userId, title: thread.title, agentId: thread.agentId, skillId: null, messages: [...messages, terminal], summary: thread.summary, summarizedCount: thread.summarizedCount }));
          };
          const { results, noteLines } = yield* collectResumeResults(rows, (row) => executeAssistantWrite(row, {
            ...ctx,
            cancellation: { signal: controller.signal, onExecutionStarted: () => { executionStarted = true; executingRow = row; } },
          } as unknown as never), {
            signal: controller.signal,
            onProgress: (collected, lines) => { progressResults = collected; progressLines = lines; },
          });
          yield* releaseUnusedClaim();
          const resumeResultsNote = buildResumeResultsNote(noteLines);
          const history = controller.signal.aborted && !executionStarted && rows.some((row) => row.status === "approved")
            ? thread.messages : applyResumeResults(thread.messages, [batchId]);
          const resumeToolLog = resumeOutcomeLog(noteLines);
          const boundSkills = yield* Effect.promise(() => loadBoundSkills("assistant"));
          const { skillMarkdowns, skillCatalog } = buildSkillPromptParts(lastUserText(history), boundSkills);
          const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
          const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
          const memoryHits = yield* memoryRepo.searchByProject(thread.projectId, extractMemoryTerms("", ""));
          const jevConfig = yield* jevService.resolveForProject(thread.projectId);
          const systemPrompts = buildSystemPrompts({ identity: CHAT_IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: null, skillMarkdowns, skillCatalog, writeTools: enabledWriteTools });
          const localWriteTracker = createLocalWriteTracker();
          const writeSet = buildWriteToolset(settingsRow, { projectId: thread.projectId, documentType: "chat", documentId: chatId, ownerUserId: userId }, thread.permissionMode, localWriteTracker);
          const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
          yield* loadAssistantMcp(thread.projectId, allowlist, (toolset) => { mcp = toolset; });
          const config = configFromRow(settingsRow);
          const settingsEffort = (settingsRow as unknown as { reasoning_effort: AssistantReasoningEffort | null }).reasoning_effort;
          let citations: Citation[] = [];
          return buildStream({
            keyId: chatId, idField: "chatId", threadId: chatId, registry: activeChats, config, resolveCompactionConfig: () => Effect.runPromise(gateway.resolveProviderConfig(thread.projectId)), gatewayStream: (input) => gateway.streamChat({ projectId: thread.projectId, ...input }), localWriteTracker,
            systemPrompts, history, userTs: new Date().toISOString(), getCitations: () => citations, modelOptions: modelOptionsForTurn(resolveReasoningEffort(settingsEffort), config.kind),
            userContent: "", skipUserEntry: true, approvalResults: results, ...(resumeResultsNote !== "" ? { resumeResultsNote } : {}), ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools, writeMode: thread.permissionMode,
            tools: [...buildAssistantTools({ ...buildToolDeps(thread.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills, env.AI), onCitation: (c) => { citations = collectCitation(citations, c); } }), ...writeSet.tools, ...(mcp?.tools ?? [])],
            toolRoundCap: MAX_CHAT_TOOL_ROUNDS, loadImageBase64: loadImageBase64For(thread.projectId, chatId, userId), loadDocumentText, imageMode, historySummary: () => thread.summary, historySummarizedCount: () => thread.summarizedCount, onDispose: async () => { try { if (mcp) await mcp.close(); } finally { release(); } },
            persist: (messages, summary, summarizedCount) => {
              const tail = messages.at(-1) as { role?: string; toolLog?: Array<{ name: string; detail?: string }> } | undefined;
              const canonical = resumeToolLog.length > 0 && tail?.role === "assistant"
                ? [...messages.slice(0, -1), { ...tail, toolLog: [...resumeToolLog, ...(tail.toolLog ?? [])] }] : messages;
              return Effect.runPromise(threadRepo.saveThread("chat", chatId, { projectId: thread.projectId, ownerUserId: userId, title: thread.title, agentId: thread.agentId, skillId: null, messages: canonical, summary, summarizedCount })).then(() => {});
            },
            onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
          });
        }).pipe(Effect.onError((cause) => Effect.uninterruptible(Effect.promise(async () => {
          const stopped = controller.signal.aborted || Cause.isInterrupted(cause);
          controller.abort();
          try {
            await Effect.runPromise(releaseUnusedClaim());
            if (executionStarted && persistResumeOutcome) await persistResumeOutcome(stopped);
          } finally {
            try { if (mcp) await mcp.close(); } catch {}
            finally { release(); }
          }
        }))));
      }),
    };
  }),
}) {}
