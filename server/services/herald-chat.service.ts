import { Effect } from "effect";
import { buildHeraldTools, MAX_CHAT_TOOL_ROUNDS } from "../herald/tools";
import { buildSystemPrompts, extractMemoryTerms, memoryBlockFromHits, CHAT_IDENTITY } from "../herald/prompt";
import { HeraldSettingsRepo, type HeraldSettingsRow } from "../repos/herald-settings.repo";
import { HeraldThreadRepo } from "../repos/herald-thread.repo";
import { HeraldPendingWritesRepo } from "../repos/herald-pending-writes.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage } from "../storage/storage";
import { Sqlite, DbError, RowNotFound } from "../db/database";
import { HeraldGateway } from "../herald/gateway.service";
import { ProviderNotConfigured, EngineNotSupportedForChat, SkillNotFound, VisionNotConfigured, InvalidArgs, HeraldThreadNotFound, HeraldTaskActive, ApprovalsPending, ApprovalNotFound, ApprovalAlreadyDecided, ApprovalExpired } from "../api/errors";
import { buildHeraldWriteTools, createWriteRecorder, parseWriteTools, type HeraldWriteToolDeps, type QueuedProposal } from "../herald/write-tools";
import { executeHeraldWrite } from "../herald/write-execution";
import { TaskService } from "./task.service";
import { CommentService } from "./comment.service";
import { WikiService } from "./wiki.service";
import { MilestoneService } from "./milestone.service";
import { SwimlaneService } from "./swimlane.service";
import { AuthorizationService } from "./authorization.service";
import { parseTaskKey } from "../task-key";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc } from "../../shared/types";
import type { HeraldChatStreamRequest } from "../../shared/herald";
import { buildStream, findPendingBatch, applyResumeResults } from "../herald/build-stream";
import { scanMentionTokens, buildMentionContextBlock, type ResolvedMention, resolveHeraldThread, resolveChatTitle, collectCitation, CHAT_IMAGE_CAPS, CHAT_CITATION_CAP, assertAttachmentCaps, resolveReasoningEffort, modelOptionsForEffort, modelOptionsWithWriteIntent, bytesToBase64, buildChatSnippet, validateChatFromIndex } from "./herald-helpers";
import { docToMarkdown } from "../../shared/markdown";
import { buildAnalyzeImageTool, resolveVisionMode } from "../herald/vision";
import type { ProviderConfig } from "../herald/provider";
import { activeChats, tryAcquireChat } from "../herald/active-chats";

export class HeraldChatService extends Effect.Service<HeraldChatService>()("Lexa/HeraldChatService", {
  dependencies: [HeraldSettingsRepo.Default, HeraldThreadRepo.Default, HeraldPendingWritesRepo.Default, ProjectMemoryRepo.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default, HeraldGateway.Default, TaskService.Default, CommentService.Default, WikiService.Default, MilestoneService.Default, SwimlaneService.Default, AuthorizationService.Default],
  effect: Effect.gen(function* () {
    const settingsRepo = yield* HeraldSettingsRepo;
    const threadRepo = yield* HeraldThreadRepo;
    const pendingWritesRepo = yield* HeraldPendingWritesRepo;
    const memoryRepo = yield* ProjectMemoryRepo;
    const storage = yield* Storage;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const db = yield* Sqlite;
    const gateway = yield* HeraldGateway;
    const taskService = yield* TaskService;
    const commentService = yield* CommentService;
    const wikiService = yield* WikiService;
    const milestoneService = yield* MilestoneService;
    const swimlaneService = yield* SwimlaneService;
    const authz = yield* AuthorizationService;

    const configFromRow = (row: HeraldSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { model: string }).model ?? "" });
    const visionConfigOf = (row: HeraldSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { vision_model: string | null }).vision_model ?? "" });
    const resolveMimeType = (projectId: string, key: string): Promise<string> => Promise.resolve((db.prepare(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, key) as { mime_type?: string } | undefined)?.mime_type ?? "image/png");
    const skillJunctionBound = (agentId: string, skillId: string): boolean => db.prepare(`SELECT 1 FROM lexa_agent_skills WHERE agent_id = ? AND skill_id = ? LIMIT 1`).get(agentId, skillId) !== null;
    const getSettingsOrFail = (projectId: string) => settingsRepo.getByProject(projectId).pipe(Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId })));
    const loadImageBase64 = (key: string): Promise<string | null> => Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);
    const resolveMentionContext = (projectId: string, message: string): Effect.Effect<string, DbError> => Effect.gen(function* () {
      const tokens = scanMentionTokens(message);
      if (tokens.length === 0) return "";
      const seen = new Set<string>();
      const resolved: ResolvedMention[] = [];
      for (const token of tokens) {
        if (resolved.length >= 5) break;
        const parsed = parseTaskKey(token);
        if (parsed) {
          const dedupeKey = `task:${parsed.prefix}-${parsed.number}`;
          if (seen.has(dedupeKey)) continue;
          const t = yield* taskRepo.findByKey(`${parsed.prefix}-${parsed.number}`).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)), Effect.catchAll(() => Effect.succeed(null)));
          if (!t || (t as unknown as { projectId: string }).projectId !== projectId) continue;
          seen.add(dedupeKey);
          resolved.push({ kind: "task", id: (t as unknown as { id: string }).id, label: `${(t as unknown as { key: string }).key} — ${(t as unknown as { title: string }).title}`, text: extractText((t as unknown as { description: TipTapDoc }).description as TipTapDoc) });
        } else {
          const slug = token.toLowerCase();
          const dedupeKey = `wiki:${slug}`;
          if (seen.has(dedupeKey)) continue;
          const page = yield* wikiRepo.findBySlug(projectId, token).pipe(Effect.catchTag("RowNotFound", () => wikiRepo.findBySlug(projectId, slug).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)), Effect.catchAll(() => Effect.succeed(null)))), Effect.catchAll(() => Effect.succeed(null)));
          if (!page) continue;
          seen.add(dedupeKey);
          resolved.push({ kind: "wiki", id: (page as unknown as { id: string }).id, label: (page as unknown as { title: string }).title, text: extractText((page as unknown as { content: TipTapDoc }).content as TipTapDoc) });
        }
      }
      return buildMentionContextBlock(resolved);
    });
    const validateAttachments = (projectId: string, attachments: ReadonlyArray<{ storageKey: string; mimeType: string }>, caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }): Effect.Effect<void, InvalidArgs | DbError> => Effect.gen(function* () {
      for (const a of attachments) {
        const row = db.prepare(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, a.storageKey) as { mime_type?: string } | undefined;
        if (!row) return yield* new InvalidArgs({ reason: `attachment '${a.storageKey}' does not belong to this project` });
        const dbMime = row.mime_type ?? "";
        if (a.mimeType !== dbMime) return yield* new InvalidArgs({ reason: `attachment '${a.storageKey}' mimeType mismatch` });
      }
      const sized = yield* Effect.forEach(attachments, (a) => storage.stat(a.storageKey).pipe(Effect.catchTag("StorageError", () => Effect.succeed(null)), Effect.map((size) => ({ mimeType: a.mimeType, size: size ?? 0 }))));
      yield* Effect.try({ try: () => assertAttachmentCaps(sized, caps), catch: (e) => e as InvalidArgs });
    });
    const buildToolDeps = (projectId: string, allowlist: string | null, searchApiKey: string | null) => ({
      projectId, allowlist, searchApiKey, fetchImpl: fetch,
      storageGet: (key: string) => Effect.runPromise(storage.get(key)),
      projectOwnsStorageKey: (pid: string, key: string) => Promise.resolve(db.prepare(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(pid, key) !== null),
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || (t as unknown as { projectId: string }).projectId !== projectId) return null;
        const col = db.prepare(`SELECT name FROM columns WHERE id = ?`).get((t as unknown as { columnId: string }).columnId) as { name: string } | undefined;
        const lane = db.prepare(`SELECT name, milestone_id FROM swimlanes WHERE id = ?`).get((t as unknown as { swimlaneId: string }).swimlaneId) as { name: string; milestone_id: string | null } | undefined;
        let milestoneName: string | null = null;
        if (lane?.milestone_id) { const m = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(lane.milestone_id) as { name: string } | undefined; milestoneName = m?.name ?? null; }
        return { id: (t as unknown as { id: string }).id, key: (t as unknown as { key: string }).key, title: (t as unknown as { title: string }).title, priority: (t as unknown as { priority: string }).priority, dueAt: (t as unknown as { dueAt: string | null }).dueAt, archivedAt: (t as unknown as { archivedAt: string | null }).archivedAt, markdown: docToMarkdown((t as unknown as { description: TipTapDoc }).description as TipTapDoc), columnName: col?.name ?? "", swimlaneName: lane?.name ?? "", milestoneName, type: (t as unknown as { type: string }).type, assignees: (t as unknown as { assignees: string[] }).assignees, githubIssue: null };
      },
      searchTasksByTitle: async (query: string, limit = 10) => { const rows = await Effect.runPromise(taskRepo.searchByTitle(projectId, query, limit)).catch(() => [] as unknown[]); return (rows as unknown as Array<{ id: string; key: string; title: string; priority: string; dueAt: string | null; archivedAt: string | null; description: TipTapDoc }>).map((t) => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: docToMarkdown(t.description as TipTapDoc) })); },
      searchWikiPages: async (query: string, limit = 10) => { const rows = await Effect.runPromise(wikiRepo.search(projectId, query, limit)).catch(() => []); return rows.map((p) => ({ title: (p as unknown as { title: string }).title, slug: (p as unknown as { slug: string }).slug, snippet: (p as unknown as { snippet: string }).snippet })); },
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); if (!page) return null; return { title: (page as unknown as { title: string }).title, slug: (page as unknown as { slug: string }).slug, content: (page as unknown as { content: TipTapDoc }).content as TipTapDoc }; },
      listAllTasks: async () => { const rows = await Effect.runPromise(taskRepo.listByProject(projectId)).catch(() => [] as unknown[]); return (rows as unknown as Array<{ id: string; key: string; title: string; priority: string; dueAt: string | null; archivedAt: string | null; description: TipTapDoc }>).map((t) => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: docToMarkdown(t.description as TipTapDoc) })); },
      listWikiPagesFull: async () => { const rows = await Effect.runPromise(wikiRepo.findFullByProject(projectId)).catch(() => [] as unknown[]); return (rows as unknown as Array<{ title: string; slug: string; content: TipTapDoc }>).map((p) => ({ title: p.title, slug: p.slug, content: p.content as TipTapDoc })); },
      getBoardStructure: async () => {
        const columns = (db.prepare(`SELECT id, name, position, wip_limit, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; position: number; wip_limit: number | null; github_state: "open" | "closed" | null; is_done: number }>).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wip_limit, githubState: c.github_state, isDone: c.is_done !== 0 }));
        const swimlanes = (db.prepare(`SELECT id, name, kind, start_at, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; kind: "backlog" | "sprint"; start_at: string | null; due_at: string | null; archived_at: string | null; milestone_id: string | null }>).map((l) => ({ id: l.id, name: l.name, kind: l.kind, startAt: l.start_at, dueAt: l.due_at, archived: l.archived_at !== null, milestoneId: l.milestone_id }));
        const milestones = (db.prepare(`SELECT id, name, due_at, archived_at FROM milestones WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; due_at: string | null; archived_at: string | null }>).map((m) => ({ id: m.id, name: m.name, dueAt: m.due_at, archived: m.archived_at !== null }));
        return { columns, swimlanes, milestones };
      },
    });
    const makeWriteDeps = (projectId: string, recorder: ReturnType<typeof createWriteRecorder>): HeraldWriteToolDeps => ({
      projectId,
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || (t as unknown as { projectId: string }).projectId !== projectId) return null;
        const col = db.prepare(`SELECT name FROM columns WHERE id = ?`).get((t as unknown as { columnId: string }).columnId) as { name: string } | undefined;
        return { id: (t as unknown as { id: string }).id, key: (t as unknown as { key: string }).key, title: (t as unknown as { title: string }).title, columnName: col?.name ?? "", priority: (t as unknown as { priority: string }).priority, type: (t as unknown as { type: string }).type, dueAt: (t as unknown as { dueAt: string | null }).dueAt, assignees: (t as unknown as { assignees: string[] }).assignees, descriptionText: extractText((t as unknown as { description: TipTapDoc }).description as TipTapDoc), archivedAt: (t as unknown as { archivedAt: string | null }).archivedAt };
      },
      findColumn: async (id: string) => (db.prepare(`SELECT id, name FROM columns WHERE id = ?`).get(id) as { id: string; name: string } | undefined) ?? null,
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); if (!page) return null; return { slug: (page as unknown as { slug: string }).slug, title: (page as unknown as { title: string }).title, text: extractText((page as unknown as { content: TipTapDoc }).content as TipTapDoc) }; },
      findMilestone: async (id: string) => { const m = db.prepare(`SELECT id, name, due_at, archived_at FROM milestones WHERE id = ?`).get(id) as { id: string; name: string; due_at: string | null; archived_at: string | null } | undefined; return m ? { id: m.id, name: m.name, dueAt: m.due_at, archivedAt: m.archived_at } : null; },
      findSwimlane: async (id: string) => { const l = db.prepare(`SELECT id, name, kind FROM swimlanes WHERE id = ?`).get(id) as { id: string; name: string; kind: "backlog" | "milestone" | "sprint" } | undefined; return l ? { id: l.id, name: l.name, kind: l.kind } : null; },
      countSprints: async (milestoneId) => { const r = db.prepare(`SELECT COUNT(*) AS c FROM swimlanes WHERE milestone_id = ? AND kind = 'sprint' AND archived_at IS NULL`).get(milestoneId) as { c: number } | undefined; return r?.c ?? 0; },
      record: recorder.record,
    });
    const buildWriteToolset = (settingsRow: HeraldSettingsRow, turn: { projectId: string; documentType: "task" | "wiki" | "chat"; documentId: string; ownerUserId: string }): { tools: unknown[]; drain: (() => QueuedProposal[]) | undefined } => {
      const enabled = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
      if (enabled.length === 0) return { tools: [], drain: undefined };
      const recorder = createWriteRecorder(turn, (row) => Effect.runPromise(pendingWritesRepo.insert({ id: row.id, project_id: row.projectId, document_type: row.documentType, document_id: row.documentId, owner_user_id: row.ownerUserId, batch_id: row.batchId, seq: row.seq, tool_name: row.toolName, args: row.args, diff: row.diff, expires_at: row.expiresAt })).then(() => {}));
      const all = buildHeraldWriteTools(makeWriteDeps(turn.projectId, recorder)) as Array<{ name: string }>;
      const tools = all.filter((t) => enabled.includes(t.name));
      return tools.length === 0 ? { tools: [], drain: undefined } : { tools, drain: () => recorder.drain() };
    };

    return {
      activeChats,
      MAX_CHAT_TOOL_ROUNDS,
      abortChat: (chatId: string): boolean => { activeChats.get(chatId)?.abort(); return activeChats.has(chatId); },
      chatActive: (chatId: string): boolean => activeChats.has(chatId),
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
      runChatStream: (chatId: string, userId: string, req: HeraldChatStreamRequest) => Effect.gen(function* () {
        if (!tryAcquireChat(chatId)) return yield* new HeraldTaskActive();
        return yield* Effect.gen(function* () {
        const settingsRow = yield* getSettingsOrFail(req.projectId);
        if ((settingsRow as unknown as { engine: string }).engine === "blacksmith") return yield* new EngineNotSupportedForChat({ engine: (settingsRow as unknown as { engine: string }).engine });
        const config = configFromRow(settingsRow);
        if (req.skillId !== undefined && !skillJunctionBound("hearth-herald", req.skillId)) return yield* new SkillNotFound({ id: req.skillId });
        const attachments = req.attachments ?? [];
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        yield* validateAttachments(req.projectId, attachments, CHAT_IMAGE_CAPS);
        if (attachments.length > 0 && imageMode === "none") return yield* new VisionNotConfigured();
        const mentionContext = yield* resolveMentionContext(req.projectId, req.message);
        yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
        const existing = yield* threadRepo.loadChat(chatId, userId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
        if (existing && existing.projectId !== req.projectId) return yield* new HeraldThreadNotFound({ documentType: "chat", documentId: chatId });
        let verdict = resolveHeraldThread(existing, req.agentId ?? null, req.skillId ?? null);
        const title = resolveChatTitle(existing, req.message);
        if (req.fromIndex !== undefined) {
          const fromIndex = req.fromIndex;
          yield* Effect.try({ try: () => { validateChatFromIndex(verdict.messages, fromIndex); }, catch: (e) => e as InvalidArgs });
          if (fromIndex < verdict.messages.length) {
            const truncated = yield* threadRepo.truncateChatFrom(chatId, userId, fromIndex);
            verdict = resolveHeraldThread(truncated, req.agentId ?? null, req.skillId ?? null);
            const orphanBatch = findPendingBatch(verdict.messages);
            if (orphanBatch !== null) return yield* new ApprovalsPending({ batchId: orphanBatch, remaining: 0 });
          }
        }
        yield* Effect.try({
          try: () => {
            const exists = db
              .prepare(`SELECT 1 FROM herald_threads WHERE document_type = 'chat' AND document_id = ? LIMIT 1`)
              .get(chatId);
            if (!exists) {
              db.prepare(
                `INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat', ?, ?, ?, '[]') ON CONFLICT(document_type, document_id) DO NOTHING`
              ).run(chatId, req.projectId, userId);
            }
          },
          catch: () => new DbError({ message: "failed to init chat thread" }),
        }).pipe(Effect.catchAll(() => Effect.succeed(0)));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(req.projectId, extractMemoryTerms(req.message, ""));
        const systemPrompts = buildSystemPrompts({ identity: CHAT_IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: null, skillMarkdown: null, mentionContext, writeTools: enabledWriteTools });
        const refs: unknown[] = attachments.map((a) => ({ type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType }));
        const userContent: string | unknown[] = refs.length > 0 ? [{ type: "text", content: req.message }, ...refs] : req.message;
        let citations: import("../../shared/herald").Citation[] = [];
        let chatWriteDrain: (() => QueuedProposal[]) | undefined;
        const baseModelOptions = modelOptionsForEffort(
          resolveReasoningEffort(
            (settingsRow as unknown as { reasoning_effort: import("../../shared/herald").HeraldReasoningEffort | null }).reasoning_effort,
            req.reasoningEffort
          )
        );
        const modelOptions = modelOptionsWithWriteIntent(baseModelOptions, req.message, enabledWriteTools);
        return buildStream({
          keyId: chatId, idField: "chatId", threadId: chatId, registry: activeChats, config, gatewayStream: (input: unknown) => gateway.streamChat({ projectId: req.projectId, ...(input as object) } as never),
          systemPrompts, history: verdict.messages, userTs: new Date().toISOString(), getCitations: () => citations, modelOptions,
          userContent, tools: (() => {
            const base = buildHeraldTools({ ...buildToolDeps(req.projectId, (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key), onCitation: (c) => { citations = collectCitation(citations, c); } });
            const writeSet = buildWriteToolset(settingsRow, { projectId: req.projectId, documentType: "chat", documentId: chatId, ownerUserId: userId });
            chatWriteDrain = writeSet.drain;
            return imageMode === "delegate" && attachments.length > 0 ? [...base, buildAnalyzeImageTool({ config: visionConfigOf(settingsRow), loadImageBase64, resolveMimeType: (key) => resolveMimeType(req.projectId, key), fetchImpl: fetch }), ...writeSet.tools] : [...base, ...writeSet.tools];
          })(), toolRoundCap: MAX_CHAT_TOOL_ROUNDS, loadImageBase64, imageMode: attachments.length > 0 ? imageMode : "inline", ...(chatWriteDrain ? { writeDrain: chatWriteDrain } : {}), writeTools: enabledWriteTools, historySummary: () => verdict.summary, historySummarizedCount: () => verdict.summarizedCount,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread("chat", chatId, { projectId: req.projectId, ownerUserId: userId, title, agentId: req.agentId ?? null, skillId: req.skillId ?? null, messages, summary, summarizedCount })).then(() => {}),
          onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
        });
        }).pipe(Effect.tapError(() => Effect.sync(() => { activeChats.delete(chatId); })));
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
      resumeChatStream: (chatId: string, userId: string) => Effect.gen(function* () {
        if (!tryAcquireChat(chatId)) return yield* new HeraldTaskActive();
        return yield* Effect.gen(function* () {
        yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
        const thread = yield* threadRepo.loadChat(chatId, userId).pipe(Effect.catchTag("RowNotFound", () => new HeraldThreadNotFound({ documentType: "chat", documentId: chatId })));
        const settingsRow = yield* getSettingsOrFail(thread.projectId);
        yield* pendingWritesRepo.sweepExpired().pipe(Effect.catchAll(() => Effect.succeed(0)));
        if ((settingsRow as unknown as { engine: string }).engine === "blacksmith") return yield* new EngineNotSupportedForChat({ engine: (settingsRow as unknown as { engine: string }).engine });
        const batchId = findPendingBatch(thread.messages);
        if (batchId === null) return yield* new ApprovalsPending({ batchId: "", remaining: 0 });
        const rows = yield* pendingWritesRepo.listByBatch(batchId);
        const remaining = rows.filter((r) => r.status === "pending").length;
        if (remaining > 0) return yield* new ApprovalsPending({ batchId, remaining });
        const results: Array<{ approvalId: string; status: "applied" | "failed" | "denied"; error?: string }> = [];
        const ctx = { db, taskService, commentService, wikiService, milestoneService, swimlaneService, authz, pendingWritesRepo, taskRepo, wikiRepo };
        const executeApprovedRow = (row: (typeof rows)[number]) => executeHeraldWrite(row, ctx as unknown as never);
        for (const row of rows) {
          if (row.status === "approved") { const outcome = yield* executeApprovedRow(row); results.push(outcome.ok ? { approvalId: row.id, status: "applied" as const } : { approvalId: row.id, status: "failed" as const, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }); }
          else if (row.status === "rejected") results.push({ approvalId: row.id, status: "denied" as const });
        }
        const history = applyResumeResults(thread.messages, [batchId]);
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(thread.projectId, extractMemoryTerms("", ""));
        const systemPrompts = buildSystemPrompts({ identity: CHAT_IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: null, skillMarkdown: null, writeTools: enabledWriteTools });
        const writeSet = buildWriteToolset(settingsRow, { projectId: thread.projectId, documentType: "chat", documentId: chatId, ownerUserId: userId });
        let citations: import("../../shared/herald").Citation[] = [];
        return buildStream({
          keyId: chatId, idField: "chatId", threadId: chatId, registry: activeChats, config: configFromRow(settingsRow), gatewayStream: (input: unknown) => gateway.streamChat({ projectId: thread.projectId, ...(input as object) } as never),
          systemPrompts, history, userTs: new Date().toISOString(), getCitations: () => citations, modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/herald").HeraldReasoningEffort | null }).reasoning_effort)),
          userContent: "", skipUserEntry: true, approvalResults: results, ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools,
          tools: [...buildHeraldTools({ ...buildToolDeps(thread.projectId, (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key), onCitation: (c) => { citations = collectCitation(citations, c); } }), ...writeSet.tools],
          toolRoundCap: MAX_CHAT_TOOL_ROUNDS, loadImageBase64, imageMode, historySummary: () => thread.summary, historySummarizedCount: () => thread.summarizedCount,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread("chat", chatId, { projectId: thread.projectId, ownerUserId: userId, title: thread.title, agentId: thread.agentId, skillId: thread.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
        });
        }).pipe(Effect.tapError(() => Effect.sync(() => { activeChats.delete(chatId); })));
      }),
    };
  }),
}) {}
