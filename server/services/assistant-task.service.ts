import { Effect } from "effect";
import { buildAssistantTools, MAX_TOOL_ROUNDS, type BoundSkill } from "../assistant/tools";
import { buildPreflightState, jevLog, runJevPreflight, type JevPreflightResult, type JevRuntimeConfig } from "../assistant/jev";
import { buildMcpTools, ENABLED_MCP_SERVERS_SQL, type McpToolset } from "../assistant/mcp";
import type { McpServerRowWithSecret } from "../repos/assistant-mcp.repo";
import { currentEnv } from "../runtime-env";
import { buildSystemPrompts, extractMemoryTerms, memoryBlockFromHits, IDENTITY, buildUserMessage } from "../assistant/prompt";
import { AssistantSettingsRepo, type AssistantSettingsRow } from "../repos/assistant-settings.repo";
import { AssistantThreadRepo, type AssistantThread } from "../repos/assistant-thread.repo";
import { AssistantPendingWritesRepo } from "../repos/assistant-pending-writes.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { AssistantTaskRepo } from "../repos/assistant-task.repo";
import { AssistantCatalogRepo } from "../repos/assistant-catalog.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage } from "../storage/storage";
import { Db, DbError, RowNotFound, queryFirst, run, withTx, ConstraintViolation, type SqlParam } from "../db/db";
import { AssistantCatalogService } from "./assistant-catalog.service";
import { AssistantJevService } from "./assistant-jev.service";
import { loadTaskRepoContent } from "./assistant-repo-content";
import { AssistantGateway } from "../assistant/gateway.service";
import { ProviderNotConfigured, AgentNotFound, SkillNotFound, VisionNotConfigured, InvalidArgs, AssistantTaskActive, AssistantTaskNotFound, TaskNotFound, WikiPageNotFound, AssistantThreadNotFound, ApprovalsPending, ApprovalNotFound, ApprovalAlreadyDecided, ApprovalExpired } from "../api/errors";
import { buildAssistantWriteTools, createWriteRecorder, parseWriteTools, type AssistantWriteToolDeps, type QueuedProposal } from "../assistant/write-tools";
import { executeAssistantWrite } from "../assistant/write-execution";
import { AuthorizationService } from "./authorization.service";
import { TaskService } from "./task.service";
import { CommentService } from "./comment.service";
import { WikiService } from "./wiki.service";
import { MilestoneService } from "./milestone.service";
import { SwimlaneService } from "./swimlane.service";
import { ActivityService } from "./activity.service";
import { docToMarkdown } from "../../shared/markdown";
import { extractText } from "../../shared/tiptap-text";
import * as msg from "../activity-messages";
import type { TipTapDoc, Task, WikiPage, Actor, AssistantTask, ActivityType } from "../../shared/types";
import { buildAnalyzeImageTool, resolveVisionMode } from "../assistant/vision";
import { buildStream, findPendingBatch, applyResumeResults, buildResumeResultsNote } from "../assistant/build-stream";
import { collectResumeResults } from "../assistant/resume-results";
import { resolveAssistantThread, needsSummary, assertAttachmentCaps, DOC_IMAGE_CAPS, resolveReasoningEffort, modelOptionsForEffort, bytesToBase64, matchBoundSkillByName, BOUND_SKILLS_SQL } from "./assistant-helpers";
import type { ProviderConfig } from "../assistant/provider";
import type { TaskRef } from "../assistant/tools";

const activeTasks = new Map<string, AbortController>();

export class AssistantTaskService extends Effect.Service<AssistantTaskService>()("Lexa/AssistantTaskService", {
  dependencies: [AssistantTaskRepo.Default, AssistantCatalogRepo.Default, AssistantSettingsRepo.Default, AssistantThreadRepo.Default, AssistantPendingWritesRepo.Default, ProjectMemoryRepo.Default, ActivityService.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default, AssistantGateway.Default, AssistantJevService.Default, TaskService.Default, CommentService.Default, WikiService.Default, MilestoneService.Default, SwimlaneService.Default, AuthorizationService.Default],
  effect: Effect.gen(function* () {
    const queueRepo = yield* AssistantTaskRepo;
    const catalogRepo = yield* AssistantCatalogRepo;
    const settingsRepo = yield* AssistantSettingsRepo;
    const threadRepo = yield* AssistantThreadRepo;
    const pendingWritesRepo = yield* AssistantPendingWritesRepo;
    const memoryRepo = yield* ProjectMemoryRepo;
    const activityService = yield* ActivityService;
    const storage = yield* Storage;
    const taskRepo = yield* TaskRepo;
    const wikiRepo = yield* WikiRepo;
    const db = yield* Db;
    const dbFirst = <T>(sql: string, ...params: SqlParam[]): Promise<T | null> =>
      db.prepare(sql).first(...params).then((row) => row as unknown as T | null);
    const dbAll = <T>(sql: string, ...params: SqlParam[]): Promise<T[]> =>
      db.prepare(sql).all(...params).then((rows) => rows as unknown as T[]);
    const taskService = yield* TaskService;
    const commentService = yield* CommentService;
    const wikiService = yield* WikiService;
    const milestoneService = yield* MilestoneService;
    const swimlaneService = yield* SwimlaneService;
    const authz = yield* AuthorizationService;
    const gateway = yield* AssistantGateway;
    const jevService = yield* AssistantJevService;

    // Read-only MCP tools for this project: globally + project enabled servers,
    // discovered fail-open. Undefined when the project has none.
    const loadAssistantMcp = (projectId: string, allowlist: string | null): Effect.Effect<McpToolset | undefined> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const servers = yield* Effect.tryPromise({
          try: () => dbAll<McpServerRowWithSecret>(ENABLED_MCP_SERVERS_SQL, projectId),
          catch: () => new DbError({ message: "failed to load enabled MCP servers" }),
        }).pipe(Effect.catchAll(() => Effect.succeed([] as McpServerRowWithSecret[])));
        if (servers.length === 0) return undefined;
        return yield* Effect.promise(() => buildMcpTools({ servers, projectId, env, allowlist }).catch(() => undefined));
      });

    // Assistant runs are unattended — the actor is the agent itself. Agent name
    // resolved at write time; falls back to the agent id.
    const agentName = (agentId: string): Effect.Effect<string, never> =>
      catalogRepo.findAgentById(agentId).pipe(
        Effect.map((a) => a.name),
        Effect.catchAll(() => Effect.succeed(agentId))
      );

    // Terminal statuses emit a task-activity row (document_type 'task' only)
    // in the SAME transaction as the status write. Message builds with the
    // RESOLVED agent name.
    const emitTerminal = (task: AssistantTask, type: ActivityType, buildMessage: (agentName: string) => string): Effect.Effect<void, never> =>
      task.documentType === "task"
        ? Effect.gen(function* () {
            const name = yield* agentName(task.agentId);
            yield* activityService.append(task.documentId, { kind: "agent", label: name }, type, buildMessage(name));
          }).pipe(
            Effect.catchAll(() => Effect.void) // a timeline row must never fail the stream round-trip
          )
        : Effect.void;

    const configFromRow = (row: AssistantSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { model: string }).model ?? "" });
    const visionConfigOf = (row: AssistantSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { vision_model: string | null }).vision_model ?? "" });
    const resolveMimeType = async (projectId: string, key: string): Promise<string> => (await dbFirst<{ mime_type?: string }>(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key))?.mime_type ?? "image/png";
    const skillJunctionBound = async (agentId: string, skillId: string): Promise<boolean> => (await dbFirst(`SELECT 1 FROM lexa_agent_skills WHERE agent_id = ? AND skill_id = ? LIMIT 1`, agentId, skillId)) !== null;
    const getSettingsOrFail = (projectId: string) => settingsRepo.getByProject(projectId).pipe(Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId })));
    const taskRefOf = (t: Task): TaskRef => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: docToMarkdown(t.description as TipTapDoc) });
    const loadDocContext = (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<{ title: string; context: string }, TaskNotFound | WikiPageNotFound | DbError | RowNotFound> => Effect.gen(function* () {
      if (documentType === "task") { const t = yield* taskRepo.findById(documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: documentId }))); const md = docToMarkdown(t.description as TipTapDoc); return { title: t.title, context: `Task: ${t.key} — ${t.title}${md ? `\nDescription:\n${md}` : ""}` }; }
      const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))); const md = docToMarkdown(page.content as TipTapDoc); return { title: page.title, context: `Wiki page: ${page.title}${md ? `\n${md}` : ""}` };
    });
    const loadImageBase64 = (key: string): Promise<string | null> => Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);
    const validateAttachments = (projectId: string, attachments: ReadonlyArray<{ storageKey: string; mimeType: string }>, caps: { maxCount: number; maxBytesEach?: number; maxTotalBytes?: number }): Effect.Effect<void, InvalidArgs | DbError> => Effect.gen(function* () {
      for (const a of attachments) { const scoped = (yield* Effect.promise(() => dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, a.storageKey))) !== null; if (!scoped) return yield* new InvalidArgs({ reason: `attachment '${a.storageKey}' does not belong to this project` }); }
      const sized = yield* Effect.forEach(attachments, (a) => storage.stat(a.storageKey).pipe(Effect.catchTag("StorageError", () => Effect.succeed(null)), Effect.map((size) => ({ mimeType: a.mimeType, size: size ?? 0 }))));
      yield* Effect.try({ try: () => assertAttachmentCaps(sized, caps), catch: (e) => e as InvalidArgs });
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
        // every task on an instance that never asked for it is pure noise.
        Effect.tap((result) => Effect.sync(() => {
          if (result.code !== "MISSING_KEY") jevLog("preflight", result);
        }))
      );
    };

    const buildToolDeps = (projectId: string, allowlist: string | null, searchApiKey: string | null, jevConfig: JevRuntimeConfig | null, boundSkills: BoundSkill[]) => ({
      projectId, allowlist, searchApiKey, jevConfig, fetchImpl: fetch,
      // get_skill can only discover skills the agent actually has bound, so the
      // loader (and with it the tool) is omitted when there are none.
      ...(boundSkills.length > 0 ? { loadSkillByName: async (name: string): Promise<BoundSkill | null> => matchBoundSkillByName(boundSkills, name) } : {}),
      storageGet: (key: string) => Effect.runPromise(storage.get(key)),
      projectOwnsStorageKey: (pid: string, key: string) => dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, pid, key).then((r) => r !== null),
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || (t as unknown as { projectId: string }).projectId !== projectId) return null;
        const [col, lane] = await Promise.all([
          dbFirst<{ name: string }>(`SELECT name FROM columns WHERE id = ?`, (t as unknown as { columnId: string }).columnId),
          dbFirst<{ name: string; milestone_id: string | null }>(`SELECT name, milestone_id FROM swimlanes WHERE id = ?`, (t as unknown as { swimlaneId: string }).swimlaneId),
        ]);
        let milestoneName: string | null = null; if (lane?.milestone_id) { const m = await dbFirst<{ name: string }>(`SELECT name FROM milestones WHERE id = ?`, lane.milestone_id); milestoneName = m?.name ?? null; }
        const gi = (t as unknown as { githubs: Array<{ repo: string; issueNumber: number }> }).githubs[0];
        return { ...taskRefOf(t as unknown as Task), columnName: col?.name ?? "", swimlaneName: lane?.name ?? "", milestoneName, type: (t as unknown as { type: string }).type, assignees: (t as unknown as { assignees: string[] }).assignees, githubIssue: gi ? { repo: gi.repo, number: gi.issueNumber } : null };
      },
      searchTasksByTitle: async (query: string, limit = 10) => { const rows = await Effect.runPromise(taskRepo.searchByTitle(projectId, query, limit)).catch(() => [] as Task[]); return rows.map(taskRefOf); },
      searchWikiPages: async (query: string, limit = 10) => { const rows = await Effect.runPromise(wikiRepo.search(projectId, query, limit)).catch(() => []); return rows.map((p) => ({ title: (p as unknown as { title: string }).title, slug: (p as unknown as { slug: string }).slug, snippet: (p as unknown as { snippet: string }).snippet })); },
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); if (!page) return null; return { title: (page as unknown as { title: string }).title, slug: (page as unknown as { slug: string }).slug, content: (page as unknown as { content: TipTapDoc }).content as TipTapDoc }; },
      listAllTasks: async () => { const rows = await Effect.runPromise(taskRepo.listByProject(projectId)).catch(() => [] as Task[]); return rows.map(taskRefOf); },
      listWikiPagesFull: async () => { const rows = await Effect.runPromise(wikiRepo.findFullByProject(projectId)).catch(() => [] as WikiPage[]); return rows.map((p) => ({ title: p.title, slug: p.slug, content: p.content as TipTapDoc })); },
      getBoardStructure: async () => {
        const columns = (await dbAll<{ id: string; name: string; position: number; wip_limit: number | null; github_state: "open" | "closed" | null; is_done: number }>(`SELECT id, name, position, wip_limit, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`, projectId)).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wip_limit, githubState: c.github_state, isDone: c.is_done !== 0 }));
        const swimlanes = (await dbAll<{ id: string; name: string; kind: "backlog" | "sprint"; start_at: string | null; due_at: string | null; archived_at: string | null; milestone_id: string | null }>(`SELECT id, name, kind, start_at, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`, projectId)).map((l) => ({ id: l.id, name: l.name, kind: l.kind, startAt: l.start_at, dueAt: l.due_at, archived: l.archived_at !== null, milestoneId: l.milestone_id }));
        const milestones = (await dbAll<{ id: string; name: string; due_at: string | null; archived_at: string | null }>(`SELECT id, name, due_at, archived_at FROM milestones WHERE project_id = ? ORDER BY position`, projectId)).map((m) => ({ id: m.id, name: m.name, dueAt: m.due_at, archived: m.archived_at !== null }));
        return { columns, swimlanes, milestones };
      },
    });
    const assistantActor = (ownerUserId: string): Actor => ({ kind: "agent", label: "assistant", userId: ownerUserId });
    const makeWriteDeps = (projectId: string, recorder: ReturnType<typeof createWriteRecorder>): AssistantWriteToolDeps => ({
      projectId,
      findTaskByRef: async (ref: string) => {
        const t = await Effect.runPromise(taskRepo.findById(ref).pipe(Effect.orElse(() => taskRepo.findByKey(ref)))).catch(() => null);
        if (!t || (t as unknown as { projectId: string }).projectId !== projectId) return null;
        const col = await dbFirst<{ name: string }>(`SELECT name FROM columns WHERE id = ?`, (t as unknown as { columnId: string }).columnId);
        return { id: (t as unknown as { id: string }).id, key: (t as unknown as { key: string }).key, title: (t as unknown as { title: string }).title, columnName: col?.name ?? "", priority: (t as unknown as { priority: string }).priority, type: (t as unknown as { type: string }).type, dueAt: (t as unknown as { dueAt: string | null }).dueAt, assignees: (t as unknown as { assignees: string[] }).assignees, descriptionText: extractText((t as unknown as { description: TipTapDoc }).description as TipTapDoc), archivedAt: (t as unknown as { archivedAt: string | null }).archivedAt };
      },
      findColumn: async (id: string) => (await dbFirst<{ id: string; name: string }>(`SELECT id, name FROM columns WHERE id = ?`, id)) ?? null,
      findWikiPageBySlug: async (slug: string) => { const page = await Effect.runPromise(wikiRepo.findBySlug(projectId, slug)).catch(() => null); if (!page) return null; return { slug: (page as unknown as { slug: string }).slug, title: (page as unknown as { title: string }).title, text: extractText((page as unknown as { content: TipTapDoc }).content as TipTapDoc) }; },
      findMilestone: async (id: string) => { const m = await dbFirst<{ id: string; name: string; due_at: string | null; archived_at: string | null }>(`SELECT id, name, due_at, archived_at FROM milestones WHERE id = ?`, id); return m ? { id: m.id, name: m.name, dueAt: m.due_at, archivedAt: m.archived_at } : null; },
      findSwimlane: async (id: string) => { const l = await dbFirst<{ id: string; name: string; kind: "backlog" | "milestone" | "sprint"; archived_at: string | null; milestone_id: string | null }>(`SELECT id, name, kind, archived_at, milestone_id FROM swimlanes WHERE id = ?`, id); return l ? { id: l.id, name: l.name, kind: l.kind, archivedAt: l.archived_at, milestoneId: l.milestone_id } : null; },
      countSprints: async (milestoneId) => { const r = await dbFirst<{ c: number }>(`SELECT COUNT(*) AS c FROM swimlanes WHERE milestone_id = ? AND kind = 'sprint' AND archived_at IS NULL`, milestoneId); return r?.c ?? 0; },
      record: recorder.record,
    });
    const buildWriteToolset = (settingsRow: AssistantSettingsRow, turn: { projectId: string; documentType: "task" | "wiki" | "chat"; documentId: string; ownerUserId: string }): { tools: unknown[]; drain: (() => QueuedProposal[]) | undefined } => {
      const enabled = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
      if (enabled.length === 0) return { tools: [], drain: undefined };
      const recorder = createWriteRecorder(turn, (row) => Effect.runPromise(pendingWritesRepo.insert({ id: row.id, project_id: row.projectId, document_type: row.documentType, document_id: row.documentId, owner_user_id: row.ownerUserId, batch_id: row.batchId, seq: row.seq, tool_name: row.toolName, args: row.args, diff: row.diff, expires_at: row.expiresAt })).then(() => {}));
      const all = buildAssistantWriteTools(makeWriteDeps(turn.projectId, recorder)) as Array<{ name: string }>;
      const enabledSet = new Set(enabled);
      const tools = all.filter((t) => enabledSet.has(t.name));
      return tools.length === 0 ? { tools: [], drain: undefined } : { tools, drain: () => recorder.drain() };
    };
    const ctx = { db, taskService, commentService, wikiService, milestoneService, swimlaneService, authz, pendingWritesRepo, taskRepo, wikiRepo };
    const prepareResume = (thread: AssistantThread) => Effect.gen(function* () {
      yield* pendingWritesRepo.sweepExpired();
      const batchId = findPendingBatch(thread.messages);
      if (batchId === null) return yield* new ApprovalsPending({ batchId: "", remaining: 0 });
      const rows = yield* pendingWritesRepo.listByBatch(batchId);
      const remaining = rows.filter((r) => r.status === "pending").length;
      if (remaining > 0) return yield* new ApprovalsPending({ batchId, remaining });
      const { results, noteLines } = yield* collectResumeResults(rows, (row) => executeAssistantWrite(row as never, ctx as never));
      return { messages: applyResumeResults(thread.messages, [batchId]), results, resumeResultsNote: buildResumeResultsNote(noteLines) };
    });

    // Terminal transitions. Local so the stream callbacks (onDone/onFail/
    // onCancel) and the public methods share one path; terminal activity
    // emission stays inside the SAME transaction as the status write
    // (invariant #12).
    const completeTask = (id: string, result: string) =>
      withTx(db, Effect.gen(function* () {
        const updated = yield* queueRepo.updateTaskStatus(id, "completed", result, null).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))
        );
        yield* emitTerminal(updated, "assistant_completed", (name) => msg.assistantCompleted(name));
        return updated;
      }));
    const failTask = (id: string, error: string) =>
      withTx(db, Effect.gen(function* () {
        const updated = yield* queueRepo.updateTaskStatus(id, "failed", null, error).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))
        );
        yield* emitTerminal(updated, "assistant_failed", () => msg.assistantFailed());
        return updated;
      }));
    const cancelTask = (id: string) =>
      withTx(db, Effect.gen(function* () {
        const updated = yield* queueRepo.updateTaskStatus(id, "cancelled", null, null).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))
        );
        yield* emitTerminal(updated, "assistant_cancelled", () => msg.assistantCancelled());
        return updated;
      }));

    return {
      activeTasks,
      MAX_TOOL_ROUNDS,
      abortStream: (taskId: string): boolean => { activeTasks.get(taskId)?.abort(); return activeTasks.has(taskId); },

      // ── Queue lifecycle ──
      create: (input: {
        projectId: string;
        documentType: "task" | "wiki";
        documentId: string;
        agentId: string;
        skillId: string;
        extraPrompt?: string;
        selection: string;
      }): Effect.Effect<AssistantTask, TaskNotFound | WikiPageNotFound | AgentNotFound | SkillNotFound | DbError | RowNotFound | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* catalogRepo.findAgentById(input.agentId).pipe(
            Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId }))
          );
          yield* catalogRepo.findSkillById(input.skillId).pipe(
            Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: input.skillId }))
          );
          if (input.documentType === "task") {
            yield* taskRepo.findById(input.documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.documentId })));
          } else {
            yield* wikiRepo.findBySlug(input.projectId, input.documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.documentId })));
          }
          return yield* queueRepo.createTask({
            id: crypto.randomUUID(),
            projectId: input.projectId,
            documentType: input.documentType,
            documentId: input.documentId,
            agentId: input.agentId,
            skillId: input.skillId,
            extraPrompt: input.extraPrompt ?? "",
            selection: input.selection,
          });
        }),

      getById: (id: string): Effect.Effect<AssistantTask, AssistantTaskNotFound | DbError> =>
        queueRepo.findTaskById(id).pipe(Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))),

      listForDocument: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<AssistantTask[], DbError> =>
        queueRepo.listTasksForDocument(projectId, documentType, documentId),

      hasRunning: (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<boolean, DbError> =>
        queueRepo.listTasksForDocument(projectId, documentType, documentId).pipe(
          Effect.map((tasks) => tasks.some((t) => t.status === "running"))
        ),

      complete: (id: string, result: string) => completeTask(id, result),

      fail: (id: string, error: string) => failTask(id, error),

      cancel: (id: string) => cancelTask(id),

      enqueue: (input: { projectId: string; documentType: "task" | "wiki"; documentId: string; prompt: string; agentId: string; skillId: string; selection?: string; attachments?: Array<{ storageKey: string; mimeType: string; name: string }> }) => Effect.gen(function* () {
        const settingsRow = yield* getSettingsOrFail(input.projectId);
        yield* catalogRepo.findAgentById(input.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId })));
        yield* catalogRepo.findSkillById(input.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: input.skillId })));
        if (!(yield* Effect.promise(() => skillJunctionBound(input.agentId, input.skillId)))) return yield* new SkillNotFound({ id: input.skillId });
        if (input.documentType === "task") yield* taskRepo.findById(input.documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.documentId })));
        else yield* wikiRepo.findBySlug(input.projectId, input.documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.documentId })));
        const attachments = input.attachments ?? [];
        if (attachments.length > 0) {
          yield* validateAttachments(input.projectId, attachments, DOC_IMAGE_CAPS);
          if (resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null }) === "none") return yield* new VisionNotConfigured();
          const existing = yield* threadRepo.loadThread(input.documentType, input.documentId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
          const verdict = resolveAssistantThread(existing, input.agentId);
          yield* threadRepo.saveThread(input.documentType, input.documentId, { projectId: input.projectId, agentId: input.agentId, skillId: input.skillId, messages: [...verdict.messages, { role: "user", content: attachments.map((a) => ({ type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType })) }], summary: verdict.summary, summarizedCount: verdict.summarizedCount });
        }
        return yield* queueRepo.createTask({ id: crypto.randomUUID(), projectId: input.projectId, documentType: input.documentType, documentId: input.documentId, agentId: input.agentId, skillId: input.skillId, extraPrompt: input.prompt, selection: input.selection ?? "" });
      }),
      resetThread: (projectId: string, documentType: "task" | "wiki", documentId: string) => Effect.gen(function* () {
        const tasks = yield* queueRepo.listTasksForDocument(projectId, documentType, documentId);
        if (tasks.some((t) => t.status === "running")) return yield* new AssistantTaskActive();
        yield* threadRepo.resetThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType, documentId })));
      }),
      runStream: (taskId: string, opts?: { userId?: string }) => Effect.gen(function* () {
        const task = yield* queueRepo.claimAssistantTask(taskId).pipe(Effect.catchTag("ConstraintViolation", () => new AssistantTaskActive()), Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id: taskId })));
        const settingsRow = yield* getSettingsOrFail(task.projectId);
        const config = configFromRow(settingsRow);
        const existing = yield* threadRepo.loadThread(task.documentType, task.documentId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
        const verdict = resolveAssistantThread(existing, task.agentId);
        if (opts?.userId !== undefined) {
          yield* Effect.try({
            try: () => {
              const exists = (db as unknown as { prepare(s: string): { get(...a: unknown[]): unknown } })
                .prepare(`SELECT 1 FROM assistant_threads WHERE document_type = ? AND document_id = ? LIMIT 1`)
                .get(task.documentType, task.documentId);
              if (!exists) {
                (db as unknown as { prepare(s: string): { run(...a: unknown[]): unknown } })
                  .prepare(
                    `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES (?, ?, ?, ?, '[]') ON CONFLICT(document_type, document_id) DO NOTHING`
                  )
                  .run(task.documentType, task.documentId, task.projectId, opts.userId);
              }
            },
            catch: () => new DbError({ message: "failed to init task thread" }),
          }).pipe(Effect.catchAll(() => Effect.succeed(0)));
        }
        const agent = yield* catalogRepo.findAgentById(task.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: task.agentId })));
        const skill = yield* catalogRepo.findSkillById(task.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: task.skillId })));
        const doc = yield* loadDocContext(task.projectId, task.documentType, task.documentId);
        const repoContent = yield* loadTaskRepoContent(task).pipe(Effect.catchAll(() => Effect.succeed([])));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(task.projectId, extractMemoryTerms(doc.title, doc.context));
        // Resolved ONCE for this run from the DB registry: global enabled +
        // project opt-in + stored, decryptable key. Total — null is the gate.
        const jevConfig = yield* jevService.resolveForProject(task.projectId);
        // The selection/instruction is resolved before the prompt build because
        // it is the preflight's "latest user message": the judgment must see the
        // same text the model will.
        let effectiveSelection = task.selection ?? "";
        if (skill.id === "polish" && !effectiveSelection.trim()) { const fallback = doc.context?.trim() ? doc.context : ""; if (fallback) effectiveSelection = fallback; }
        const instruction = [effectiveSelection.trim() ? `Selected text:\n"""\n${effectiveSelection}\n"""` : null, task.extraPrompt].filter((s): s is string => !!s && s.trim() !== "").join("\n\n");
        // Preflight runs once per NEW run, never on resume; only inputs this run
        // already loaded are serialized (no history, no attachments, no keys).
        const preflight = yield* runPreflight(jevConfig, {
          runKind: "task",
          projectId: task.projectId,
          threadId: task.documentId,
          threadLabel: doc.title,
          userMessage: instruction,
          taskWikiContext: doc.context,
          memoryHits,
        });
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdowns: [skill.instructions], repoContent, docContext: doc.context, writeTools: enabledWriteTools, advisory: preflight.segment });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
        const boundSkills = yield* Effect.promise(() => dbAll<BoundSkill>(BOUND_SKILLS_SQL, task.agentId));
        const baseTools = buildAssistantTools(buildToolDeps(task.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills));
        const writeSet = opts?.userId !== undefined ? buildWriteToolset(settingsRow, { projectId: task.projectId, documentType: task.documentType, documentId: task.documentId, ownerUserId: opts.userId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const mcp = yield* loadAssistantMcp(task.projectId, allowlist);
        const mcpTools = mcp?.tools ?? [];
        const tools = imageMode === "delegate" ? [...baseTools, buildAnalyzeImageTool({ config: { ...visionConfigOf(settingsRow), sessionId: task.documentId }, loadImageBase64, resolveMimeType: (key) => resolveMimeType(task.projectId, key), fetchImpl: fetch }), ...writeSet.tools, ...mcpTools] : [...baseTools, ...writeSet.tools, ...mcpTools];
        const userContent = buildUserMessage({ instruction, summary: verdict.summary, summarizedCount: verdict.summarizedCount }) as string;
        return buildStream({
          keyId: taskId, idField: "taskId", threadId: task.documentId, registry: activeTasks, config, gatewayStream: (input: unknown) => gateway.streamChat({ projectId: task.projectId, ...(input as object) } as never),
          systemPrompts, history: verdict.messages, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/assistant").AssistantReasoningEffort | null }).reasoning_effort)),
          historySummary: () => verdict.summary, historySummarizedCount: () => verdict.summarizedCount, userContent, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64, imageMode, ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools, ...(mcp ? { onDispose: mcp.close } : {}),
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread(task.documentType, task.documentId, { projectId: task.projectId, agentId: task.agentId, skillId: task.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: (text) => Effect.runPromise(completeTask(taskId, text)).then(() => {}).catch(() => {}),
          onFail: (message) => Effect.runPromise(failTask(taskId, message)).then(() => {}).catch(() => {}),
          onCancel: async () => { await Effect.runPromise(cancelTask(taskId)).catch(() => {}); },
        });
      }),
      resumeThreadStream: (documentType: "task" | "wiki", documentId: string) => Effect.gen(function* () {
        const thread = yield* threadRepo.loadThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType, documentId })));
        const tasks = yield* queueRepo.listTasksForDocument(thread.projectId, documentType, documentId);
        if (tasks.some((t) => t.status === "running")) return yield* new AssistantTaskActive();
        const settingsRow = yield* getSettingsOrFail(thread.projectId);
        const { messages: history, results: approvalResults, resumeResultsNote } = yield* prepareResume(thread);
        if (!thread.agentId || !thread.skillId) return yield* new AgentNotFound({ id: "" });
        const agent = yield* catalogRepo.findAgentById(thread.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: thread.agentId ?? "" })));
        const skill = yield* catalogRepo.findSkillById(thread.skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: thread.skillId ?? "" })));
        const doc = yield* loadDocContext(thread.projectId, documentType, documentId);
        const repoContent = yield* loadTaskRepoContent({ projectId: thread.projectId, documentType, documentId } as Parameters<typeof loadTaskRepoContent>[0]).pipe(Effect.catchAll(() => Effect.succeed([])));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(thread.projectId, extractMemoryTerms(doc.title, doc.context));
        // No preflight on resume: the judgment was made against the original
        // request. The tool is still offered — its budget is per stream. The
        // config is resolved once here too, so a resume gets the same gate.
        const jevConfig = yield* jevService.resolveForProject(thread.projectId);
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdowns: [skill.instructions], repoContent, docContext: doc.context, writeTools: enabledWriteTools });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
        const boundSkills = yield* Effect.promise(() => dbAll<BoundSkill>(BOUND_SKILLS_SQL, thread.agentId ?? ""));
        const baseTools = buildAssistantTools(buildToolDeps(thread.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills));
        const writeSet = thread.ownerUserId !== null ? buildWriteToolset(settingsRow, { projectId: thread.projectId, documentType, documentId, ownerUserId: thread.ownerUserId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const mcp = yield* loadAssistantMcp(thread.projectId, allowlist);
        const mcpTools = mcp?.tools ?? [];
        const tools = imageMode === "delegate" ? [...baseTools, buildAnalyzeImageTool({ config: { ...visionConfigOf(settingsRow), sessionId: documentId }, loadImageBase64, resolveMimeType: (key) => resolveMimeType(thread.projectId, key), fetchImpl: fetch }), ...writeSet.tools, ...mcpTools] : [...baseTools, ...writeSet.tools, ...mcpTools];
        return buildStream({
          keyId: documentId, idField: "taskId", threadId: documentId, registry: activeTasks, config: configFromRow(settingsRow), gatewayStream: (input: unknown) => gateway.streamChat({ projectId: thread.projectId, ...(input as object) } as never),
          systemPrompts, history, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/assistant").AssistantReasoningEffort | null }).reasoning_effort)),
          userContent: "", skipUserEntry: true, approvalResults, ...(resumeResultsNote !== "" ? { resumeResultsNote } : {}), ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64, imageMode, historySummary: () => thread.summary, historySummarizedCount: () => thread.summarizedCount, ...(mcp ? { onDispose: mcp.close } : {}),
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
