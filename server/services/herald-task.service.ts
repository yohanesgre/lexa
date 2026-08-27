import { Effect } from "effect";
import { buildHeraldTools, MAX_TOOL_ROUNDS } from "../herald/tools";
import { buildSystemPrompts, extractMemoryTerms, memoryBlockFromHits, IDENTITY, buildUserMessage } from "../herald/prompt";
import { HeraldSettingsRepo, type HeraldSettingsRow } from "../repos/herald-settings.repo";
import { HeraldThreadRepo, type HeraldThread } from "../repos/herald-thread.repo";
import { HeraldPendingWritesRepo } from "../repos/herald-pending-writes.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { HearthRepo } from "../repos/hearth.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage } from "../storage/storage";
import { Sqlite, DbError, RowNotFound } from "../db/database";
import { HearthService, BLACKSMITH_AGENT, HERALD_AGENT } from "./hearth.service";
import { loadTaskRepoContent } from "./hearth-repo-content";
import { HeraldGateway } from "../herald/gateway.service";
import { ProviderNotConfigured, AgentNotFound, SkillNotFound, VisionNotConfigured, InvalidArgs, HeraldTaskActive, HearthTaskNotFound, TaskNotFound, WikiPageNotFound, NoRuntimeOnline, HeraldThreadNotFound, ApprovalsPending, ApprovalNotFound, ApprovalAlreadyDecided, ApprovalExpired } from "../api/errors";
import { buildHeraldWriteTools, createWriteRecorder, parseWriteTools, type HeraldWriteToolDeps, type QueuedProposal } from "../herald/write-tools";
import { executeHeraldWrite } from "../herald/write-execution";
import { AuthorizationService } from "./authorization.service";
import { TaskService } from "./task.service";
import { CommentService } from "./comment.service";
import { WikiService } from "./wiki.service";
import { MilestoneService } from "./milestone.service";
import { SwimlaneService } from "./swimlane.service";
import { docToMarkdown } from "../../shared/markdown";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc, Task, WikiPage, Actor } from "../../shared/types";
import { buildAnalyzeImageTool, resolveVisionMode } from "../herald/vision";
import { buildStream, findPendingBatch, applyResumeResults } from "../herald/build-stream";
import { resolveHeraldThread, needsSummary, assertAttachmentCaps, DOC_IMAGE_CAPS, resolveReasoningEffort, modelOptionsForEffort, bytesToBase64 } from "./herald-helpers";
import type { ProviderConfig } from "../herald/provider";
import type { TaskRef } from "../herald/tools";

const activeTasks = new Map<string, AbortController>();

export class HeraldTaskService extends Effect.Service<HeraldTaskService>()("Lexa/HeraldTaskService", {
  dependencies: [HearthRepo.Default, HeraldSettingsRepo.Default, HeraldThreadRepo.Default, HeraldPendingWritesRepo.Default, ProjectMemoryRepo.Default, HearthService.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default, HeraldGateway.Default, TaskService.Default, CommentService.Default, WikiService.Default, MilestoneService.Default, SwimlaneService.Default, AuthorizationService.Default],
  effect: Effect.gen(function* () {
    const hearthRepo = yield* HearthRepo;
    const settingsRepo = yield* HeraldSettingsRepo;
    const threadRepo = yield* HeraldThreadRepo;
    const pendingWritesRepo = yield* HeraldPendingWritesRepo;
    const memoryRepo = yield* ProjectMemoryRepo;
    const hearthService = yield* HearthService;
    const storage = yield* Storage;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const db = yield* Sqlite;
    const taskService = yield* TaskService;
    const commentService = yield* CommentService;
    const wikiService = yield* WikiService;
    const milestoneService = yield* MilestoneService;
    const swimlaneService = yield* SwimlaneService;
    const authz = yield* AuthorizationService;
    const gateway = yield* HeraldGateway;

    const configFromRow = (row: HeraldSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { model: string }).model ?? "" });
    const visionConfigOf = (row: HeraldSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { vision_model: string | null }).vision_model ?? "" });
    const resolveMimeType = (projectId: string, key: string): Promise<string> => Promise.resolve((db.prepare(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, key) as { mime_type?: string } | undefined)?.mime_type ?? "image/png");
    const skillJunctionBound = (agentId: string, skillId: string): boolean => db.prepare(`SELECT 1 FROM lexa_agent_skills WHERE agent_id = ? AND skill_id = ? LIMIT 1`).get(agentId, skillId) !== null;
    const getSettingsOrFail = (projectId: string) => settingsRepo.getByProject(projectId).pipe(Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId })));
    const taskRefOf = (t: Task): TaskRef => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: docToMarkdown(t.description as TipTapDoc) });
    const loadDocContext = (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<{ title: string; context: string }, TaskNotFound | WikiPageNotFound | DbError | RowNotFound> => Effect.gen(function* () {
      if (documentType === "task") { const t = yield* taskRepo.findById(documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: documentId }))); const md = docToMarkdown(t.description as TipTapDoc); return { title: t.title, context: `Task: ${t.key} — ${t.title}${md ? `\nDescription:\n${md}` : ""}` }; }
      const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))); const md = docToMarkdown(page.content as TipTapDoc); return { title: page.title, context: `Wiki page: ${page.title}${md ? `\n${md}` : ""}` };
    });
    const loadImageBase64 = (key: string): Promise<string | null> => Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);
    const validateAttachments = (projectId: string, attachments: ReadonlyArray<{ storageKey: string; mimeType: string }>, caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }): Effect.Effect<void, InvalidArgs | DbError> => Effect.gen(function* () {
      for (const a of attachments) { const scoped = db.prepare(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`).get(projectId, a.storageKey) !== null; if (!scoped) return yield* new InvalidArgs({ reason: `attachment '${a.storageKey}' does not belong to this project` }); }
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
        let milestoneName: string | null = null; if (lane?.milestone_id) { const m = db.prepare(`SELECT name FROM milestones WHERE id = ?`).get(lane.milestone_id) as { name: string } | undefined; milestoneName = m?.name ?? null; }
        const gi = (t as unknown as { githubs: Array<{ repo: string; issueNumber: number }> }).githubs[0];
        return { ...taskRefOf(t as unknown as Task), columnName: col?.name ?? "", swimlaneName: lane?.name ?? "", milestoneName, type: (t as unknown as { type: string }).type, assignees: (t as unknown as { assignees: string[] }).assignees, githubIssue: gi ? { repo: gi.repo, number: gi.issueNumber } : null };
      },
      searchTasksByTitle: async (query: string, limit = 10) => { const rows = await Effect.runPromise(taskRepo.searchByTitle(projectId, query, limit)).catch(() => [] as Task[]); return rows.map(taskRefOf); },
      searchWikiPages: async (query: string, limit = 10) => { const rows = await Effect.runPromise(wikiRepo.search(projectId, query, limit)).catch(() => []); return rows.map((p) => ({ title: (p as unknown as { title: string }).title, slug: (p as unknown as { slug: string }).slug, snippet: (p as unknown as { snippet: string }).snippet })); },
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); if (!page) return null; return { title: (page as unknown as { title: string }).title, slug: (page as unknown as { slug: string }).slug, content: (page as unknown as { content: TipTapDoc }).content as TipTapDoc }; },
      listAllTasks: async () => { const rows = await Effect.runPromise(taskRepo.listByProject(projectId)).catch(() => [] as Task[]); return rows.map(taskRefOf); },
      listWikiPagesFull: async () => { const rows = await Effect.runPromise(wikiRepo.findFullByProject(projectId)).catch(() => [] as WikiPage[]); return rows.map((p) => ({ title: p.title, slug: p.slug, content: p.content as TipTapDoc })); },
      getBoardStructure: async () => {
        const columns = (db.prepare(`SELECT id, name, position, wip_limit, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; position: number; wip_limit: number | null; github_state: "open" | "closed" | null; is_done: number }>).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wip_limit, githubState: c.github_state, isDone: c.is_done !== 0 }));
        const swimlanes = (db.prepare(`SELECT id, name, kind, start_at, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; kind: "backlog" | "sprint"; start_at: string | null; due_at: string | null; archived_at: string | null; milestone_id: string | null }>).map((l) => ({ id: l.id, name: l.name, kind: l.kind, startAt: l.start_at, dueAt: l.due_at, archived: l.archived_at !== null, milestoneId: l.milestone_id }));
        const milestones = (db.prepare(`SELECT id, name, due_at, archived_at FROM milestones WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string; name: string; due_at: string | null; archived_at: string | null }>).map((m) => ({ id: m.id, name: m.name, dueAt: m.due_at, archived: m.archived_at !== null }));
        return { columns, swimlanes, milestones };
      },
    });
    const heraldActor = (ownerUserId: string): Actor => ({ kind: "agent", label: "herald", userId: ownerUserId });
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
    const ctx = { db, taskService, commentService, wikiService, milestoneService, swimlaneService, authz, pendingWritesRepo, taskRepo, wikiRepo };
    const executeApprovedRow = (row: { id: string; project_id: string; owner_user_id: string; tool_name: string; args: string; batch_id: string }) => executeHeraldWrite(row as never, ctx as never);
    const prepareResume = (thread: HeraldThread) => Effect.gen(function* () {
      yield* pendingWritesRepo.sweepExpired();
      const batchId = findPendingBatch(thread.messages);
      if (batchId === null) return yield* new ApprovalsPending({ batchId: "", remaining: 0 });
      const rows = yield* pendingWritesRepo.listByBatch(batchId);
      const remaining = rows.filter((r) => r.status === "pending").length;
      if (remaining > 0) return yield* new ApprovalsPending({ batchId, remaining });
      const results: Array<{ approvalId: string; status: "applied" | "failed" | "denied"; error?: string }> = [];
      for (const row of rows) {
        if (row.status === "approved") { const outcome = yield* executeApprovedRow(row); results.push(outcome.ok ? { approvalId: row.id, status: "applied" as const } : { approvalId: row.id, status: "failed" as const, ...(outcome.error !== undefined ? { error: outcome.error } : {}) }); }
        else if (row.status === "rejected") results.push({ approvalId: row.id, status: "denied" as const });
      }
      return { messages: applyResumeResults(thread.messages, [batchId]), results };
    });

    return {
      activeTasks,
      MAX_TOOL_ROUNDS,
      abortStream: (taskId: string): boolean => { activeTasks.get(taskId)?.abort(); return activeTasks.has(taskId); },
      enqueue: (input: { projectId: string; documentType: "task" | "wiki"; documentId: string; prompt: string; agentId: string; skillId: string; selection?: string; attachments?: Array<{ storageKey: string; mimeType: string; name: string }> }) => Effect.gen(function* () {
        const settingsRow = yield* getSettingsOrFail(input.projectId);
        yield* hearthRepo.findAgentById(input.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId })));
        yield* hearthRepo.findSkillById(input.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: input.skillId })));
        const engine = (settingsRow as unknown as { engine: string }).engine;
        const engineAgentId = engine === "blacksmith" ? BLACKSMITH_AGENT.id : HERALD_AGENT.id;
        if (!skillJunctionBound(engineAgentId, input.skillId)) return yield* new SkillNotFound({ id: input.skillId });
        if (input.documentType === "task") yield* taskRepo.findById(input.documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.documentId })));
        else yield* wikiRepo.findBySlug(input.projectId, input.documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.documentId })));
        if (engine === "blacksmith") { const runtimes = yield* hearthRepo.listRuntimes(); if (!runtimes.some((r) => r.status === "online")) return yield* new NoRuntimeOnline(); }
        const attachments = input.attachments ?? [];
        if (attachments.length > 0) {
          yield* validateAttachments(input.projectId, attachments, DOC_IMAGE_CAPS);
          if (resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null }) === "none") return yield* new VisionNotConfigured();
          const existing = yield* threadRepo.loadThread(input.documentType, input.documentId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
          const verdict = resolveHeraldThread(existing, input.agentId, input.skillId);
          yield* threadRepo.saveThread(input.documentType, input.documentId, { projectId: input.projectId, agentId: input.agentId, skillId: input.skillId, messages: [...verdict.messages, { role: "user", content: attachments.map((a) => ({ type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType })) }], summary: verdict.summary, summarizedCount: verdict.summarizedCount });
        }
        const docContext = engine === "blacksmith" ? (yield* loadDocContext(input.projectId, input.documentType, input.documentId)).context : "";
        return yield* hearthRepo.createTask({ id: crypto.randomUUID(), projectId: input.projectId, documentType: input.documentType, documentId: input.documentId, agentId: input.agentId, skillId: input.skillId, extraPrompt: input.prompt, selection: input.selection ?? "", docContext, kind: engine as "herald" | "blacksmith" });
      }),
      resetThread: (projectId: string, documentType: "task" | "wiki", documentId: string) => Effect.gen(function* () {
        const tasks = yield* hearthRepo.listTasksForDocument(projectId, documentType, documentId);
        if (tasks.some((t) => t.kind === "herald" && t.status === "running")) return yield* new HeraldTaskActive();
        yield* threadRepo.resetThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new HeraldThreadNotFound({ documentType, documentId })));
      }),
      runStream: (taskId: string, opts?: { userId?: string }) => Effect.gen(function* () {
        const task = yield* hearthRepo.claimHeraldTask(taskId).pipe(Effect.catchTag("ConstraintViolation", () => new HeraldTaskActive()), Effect.catchTag("RowNotFound", () => new HearthTaskNotFound({ id: taskId })));
        const settingsRow = yield* getSettingsOrFail(task.projectId);
        const config = configFromRow(settingsRow);
        const existing = yield* threadRepo.loadThread(task.documentType, task.documentId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
        const verdict = resolveHeraldThread(existing, task.agentId, task.skillId);
        if (opts?.userId !== undefined) {
          yield* Effect.try({
            try: () => {
              const exists = (db as unknown as { prepare(s: string): { get(...a: unknown[]): unknown } })
                .prepare(`SELECT 1 FROM herald_threads WHERE document_type = ? AND document_id = ? LIMIT 1`)
                .get(task.documentType, task.documentId);
              if (!exists) {
                (db as unknown as { prepare(s: string): { run(...a: unknown[]): unknown } })
                  .prepare(
                    `INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES (?, ?, ?, ?, '[]') ON CONFLICT(document_type, document_id) DO NOTHING`
                  )
                  .run(task.documentType, task.documentId, task.projectId, opts.userId);
              }
            },
            catch: () => new DbError({ message: "failed to init task thread" }),
          }).pipe(Effect.catchAll(() => Effect.succeed(0)));
        }
        const agent = yield* hearthRepo.findAgentById(task.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: task.agentId })));
        const skill = yield* hearthRepo.findSkillById(task.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: task.skillId })));
        const doc = yield* loadDocContext(task.projectId, task.documentType, task.documentId);
        const repoContent = yield* loadTaskRepoContent(task).pipe(Effect.catchAll(() => Effect.succeed([])));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(task.projectId, extractMemoryTerms(doc.title, doc.context));
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdown: skill.instructions, repoContent, docContext: doc.context, writeTools: enabledWriteTools });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const baseTools = buildHeraldTools(buildToolDeps(task.projectId, (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key));
        const writeSet = opts?.userId !== undefined ? buildWriteToolset(settingsRow, { projectId: task.projectId, documentType: task.documentType, documentId: task.documentId, ownerUserId: opts.userId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const tools = imageMode === "delegate" ? [...baseTools, buildAnalyzeImageTool({ config: visionConfigOf(settingsRow), loadImageBase64, resolveMimeType: (key) => resolveMimeType(task.projectId, key), fetchImpl: fetch }), ...writeSet.tools] : [...baseTools, ...writeSet.tools];
        let effectiveSelection = task.selection ?? "";
        if (skill.id === "polish" && !effectiveSelection.trim()) { const fallback = doc.context?.trim() ? doc.context : ""; if (fallback) effectiveSelection = fallback; }
        const instruction = [effectiveSelection.trim() ? `Selected text:\n"""\n${effectiveSelection}\n"""` : null, task.extraPrompt].filter((s): s is string => !!s && s.trim() !== "").join("\n\n");
        const userContent = buildUserMessage({ instruction, summary: verdict.summary, summarizedCount: verdict.summarizedCount }) as string;
        return buildStream({
          keyId: taskId, idField: "taskId", threadId: task.documentId, registry: activeTasks, config, gatewayStream: (input: unknown) => gateway.streamChat({ projectId: task.projectId, ...(input as object) } as never),
          systemPrompts, history: verdict.messages, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/herald").HeraldReasoningEffort | null }).reasoning_effort)),
          historySummary: () => verdict.summary, historySummarizedCount: () => verdict.summarizedCount, userContent, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64, imageMode, ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread(task.documentType, task.documentId, { projectId: task.projectId, agentId: task.agentId, skillId: task.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: (text) => Effect.runPromise(hearthService.complete(taskId, text)).then(() => {}).catch(() => {}),
          onFail: (message) => Effect.runPromise(hearthService.fail(taskId, message)).then(() => {}).catch(() => {}),
          onCancel: async () => { await Effect.runPromise(hearthService.cancel(taskId)).catch(() => {}); await Effect.runPromise(hearthRepo.appendLog(crypto.randomUUID(), taskId, "aborted")).catch(() => {}); },
        });
      }),
      resumeThreadStream: (documentType: "task" | "wiki", documentId: string) => Effect.gen(function* () {
        const thread = yield* threadRepo.loadThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new HeraldThreadNotFound({ documentType, documentId })));
        const tasks = yield* hearthRepo.listTasksForDocument(thread.projectId, documentType, documentId);
        if (tasks.some((t) => t.kind === "herald" && t.status === "running")) return yield* new HeraldTaskActive();
        const settingsRow = yield* getSettingsOrFail(thread.projectId);
        const { messages: history, results: approvalResults } = yield* prepareResume(thread);
        if (!thread.agentId || !thread.skillId) return yield* new AgentNotFound({ id: "" });
        const agent = yield* hearthRepo.findAgentById(thread.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: thread.agentId ?? "" })));
        const skill = yield* hearthRepo.findSkillById(thread.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: thread.skillId ?? "" })));
        const doc = yield* loadDocContext(thread.projectId, documentType, documentId);
        const repoContent = yield* loadTaskRepoContent({ projectId: thread.projectId, documentType, documentId } as Parameters<typeof loadTaskRepoContent>[0]).pipe(Effect.catchAll(() => Effect.succeed([])));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(thread.projectId, extractMemoryTerms(doc.title, doc.context));
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdown: skill.instructions, repoContent, docContext: doc.context, writeTools: enabledWriteTools });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const baseTools = buildHeraldTools(buildToolDeps(thread.projectId, (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key));
        const writeSet = thread.ownerUserId !== null ? buildWriteToolset(settingsRow, { projectId: thread.projectId, documentType, documentId, ownerUserId: thread.ownerUserId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const tools = imageMode === "delegate" ? [...baseTools, buildAnalyzeImageTool({ config: visionConfigOf(settingsRow), loadImageBase64, resolveMimeType: (key) => resolveMimeType(thread.projectId, key), fetchImpl: fetch }), ...writeSet.tools] : [...baseTools, ...writeSet.tools];
        return buildStream({
          keyId: documentId, idField: "taskId", threadId: documentId, registry: activeTasks, config: configFromRow(settingsRow), gatewayStream: (input: unknown) => gateway.streamChat({ projectId: thread.projectId, ...(input as object) } as never),
          systemPrompts, history, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/herald").HeraldReasoningEffort | null }).reasoning_effort)),
          userContent: "", skipUserEntry: true, approvalResults, ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64, imageMode, historySummary: () => thread.summary, historySummarizedCount: () => thread.summarizedCount,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread(documentType, documentId, { projectId: thread.projectId, agentId: thread.agentId, skillId: thread.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
        });
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
    };
  }),
}) {}
