import { Effect } from "effect";
import { buildAssistantTools, MAX_TOOL_ROUNDS, type BoundSkill } from "../assistant/tools";
import { buildPreflightState, jevLog, runJevPreflight, type JevPreflightResult, type JevRuntimeConfig } from "../assistant/jev";
import { buildMcpTools, ENABLED_MCP_SERVERS_SQL, type McpToolset } from "../assistant/mcp";
import type { McpServerRowWithSecret } from "../repos/assistant-mcp.repo";
import { currentEnv } from "../runtime-env";
import { buildSystemPrompts, extractMemoryTerms, memoryBlockFromHits, IDENTITY, buildUserMessage } from "../assistant/prompt";
import { buildSkillPromptParts } from "../assistant/context";
import { AssistantSettingsRepo, type AssistantSettingsRow } from "../repos/assistant-settings.repo";
import { AssistantThreadRepo, type AssistantThread } from "../repos/assistant-thread.repo";
import { AssistantPendingWritesRepo } from "../repos/assistant-pending-writes.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { AssistantTaskRepo } from "../repos/assistant-task.repo";
import { AssistantCatalogRepo } from "../repos/assistant-catalog.repo";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage } from "../storage/storage";
import { Db, DbError, RowNotFound, batchResults, requireRow, run, ConstraintViolation, type BatchStmt, type SqlParam } from "../db/db";
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
import { AssistantProvidersService } from "./assistant-providers.service";
import { buildStream, findPendingBatch, applyResumeResults, buildResumeResultsNote } from "../assistant/build-stream";
import type { StreamFrame } from "../../shared/assistant";
import { claimResumeBatch, releaseResumeBatch } from "../assistant/resume-claim";
import { collectResumeResults } from "../assistant/resume-results";
import { resolveAssistantThread, needsSummary, assertAttachmentCaps, DOC_IMAGE_CAPS, resolveReasoningEffort, modelOptionsForEffort, bytesToBase64, matchBoundSkillByName, BOUND_SKILLS_SQL } from "./assistant-helpers";
import type { ProviderConfig } from "../assistant/provider";
import type { TaskRef } from "../assistant/tools";

const activeTasks = new Map<string, AbortController>();

// Per-document single-run lock (ADR-0005 D6, W3). Keyed by
// `${projectId}:${documentType}:${documentId}` and holding the SAME
// AbortController the run registers in `activeTasks`, so the lock, the
// stop/disconnect abort, and the stream registry are one entry. A second run on
// a live document thread is refused 409 instead of racing the thread (two tabs
// used to each stream a task and silently drop one turn).
const activeDocuments = new Map<string, AbortController>();

const documentLockKey = (projectId: string, documentType: "task" | "wiki", documentId: string): string =>
  `${projectId}:${documentType}:${documentId}`;

// Acquire the document lock with the run's controller. Returns null when the
// document already has a live run. Synchronous check-and-set (single-threaded),
// so two concurrent fibers cannot both win.
function tryAcquireDocument(projectId: string, documentType: "task" | "wiki", documentId: string, controller: AbortController): AbortController | null {
  const key = documentLockKey(projectId, documentType, documentId);
  if (activeDocuments.has(key)) return null;
  activeDocuments.set(key, controller);
  return controller;
}

function releaseDocument(projectId: string, documentType: "task" | "wiki", documentId: string, controller: AbortController): void {
  const key = documentLockKey(projectId, documentType, documentId);
  if (activeDocuments.get(key) === controller) activeDocuments.delete(key);
}

export class AssistantTaskService extends Effect.Service<AssistantTaskService>()("Lexa/AssistantTaskService", {
  dependencies: [AssistantTaskRepo.Default, AssistantCatalogRepo.Default, AssistantSettingsRepo.Default, AssistantThreadRepo.Default, AssistantPendingWritesRepo.Default, ProjectMemoryRepo.Default, ActivityService.Default, Storage.Default, TaskRepo.Default, WikiRepo.Default, AssistantGateway.Default, AssistantJevService.Default, AssistantProvidersService.Default, TaskService.Default, CommentService.Default, WikiService.Default, MilestoneService.Default, SwimlaneService.Default, AuthorizationService.Default],
  effect: Effect.gen(function* () {
    const queueRepo = yield* AssistantTaskRepo;
    const catalogRepo = yield* AssistantCatalogRepo;
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
    // instead of reading an empty stream as a stall and retrying forever
    // (parity with assistant-chat.service.ts).
    const emptyFrameStream = (): ReadableStream<StreamFrame> =>
      new ReadableStream<StreamFrame>({
        start(controller) {
          controller.enqueue({ type: "done", text: "", usage: { in: 0, out: 0 } });
          controller.close();
        },
      });
    const taskService = yield* TaskService;
    const commentService = yield* CommentService;
    const wikiService = yield* WikiService;
    const milestoneService = yield* MilestoneService;
    const swimlaneService = yield* SwimlaneService;
    const authz = yield* AuthorizationService;
    const gateway = yield* AssistantGateway;
    const jevService = yield* AssistantJevService;
    const providersService = yield* AssistantProvidersService;

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

    // Terminal status transitions. The pre-read gates existence (RowNotFound →
    // AssistantTaskNotFound) and idempotency: a run already terminal for this
    // target is a clean no-op with NO activity row (mirrors the Workers path
    // `transitionAssistantRun`). Otherwise the status write and the terminal
    // activity emission (document_type 'task' only) ride ONE atomic batch
    // (invariant #12); the INSERT is gated on `changes() > 0` so a
    // concurrently-lost transition cannot emit a spurious row. The loser of a
    // concurrent terminal transition re-reads and returns the current row
    // rather than a false NotFound. Message builds with the RESOLVED agent name.
    const runTerminal = (
      id: string,
      status: AssistantTask["status"],
      result: string | null,
      error: string | null,
      type: ActivityType,
      buildMessage: (agentName: string) => string
    ): Effect.Effect<AssistantTask, AssistantTaskNotFound | ConstraintViolation | DbError> =>
      Effect.gen(function* () {
        const task = yield* queueRepo.findTaskById(id).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))
        );
        const transitionable =
          status === "completed"
            ? task.status === "running"
            : task.status === "queued" || task.status === "running";
        if (!transitionable) return task;
        const name = yield* agentName(task.agentId);
        const stmts: BatchStmt[] = [queueRepo.updateTaskStatusStmt(id, status, result, error)];
        if (task.documentType === "task") {
          stmts.push({
            sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_assistant)
                  SELECT ?, 'agent', ?, NULL, ?, ?, 0
                  WHERE changes() > 0`,
            params: [task.documentId, name, type, buildMessage(name)],
          });
        }
        const results = yield* batchResults(db, stmts);
        // A lost race (a concurrent writer transitioned the task first) leaves
        // the conditional UPDATE with no RETURNING row. That is benign — the
        // gated INSERT emitted no activity — so re-read and return the current
        // row; only a task that is genuinely gone maps to NotFound.
        yield* requireRow(results[0], "assistant-task.runTerminal").pipe(Effect.ignore);
        return yield* queueRepo.findTaskById(id).pipe(
          Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id }))
        );
      });

    const configFromRow = (row: AssistantSettingsRow): ProviderConfig => ({ kind: (row as unknown as { kind: ProviderConfig["kind"] }).kind ?? "openai_compatible", baseUrl: (row as unknown as { base_url: string }).base_url ?? "", apiKey: (row as unknown as { api_key: string }).api_key ?? "", model: (row as unknown as { model: string }).model ?? "" });
    // Vision agent config from the registry (the legacy per-project
    // kind/base_url/api_key columns were dropped in 0008): provider base URL +
    // model-row kind, key opened through the providers service.
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
    const resolveMimeType = async (projectId: string, key: string): Promise<string> => (await dbFirst<{ mime_type?: string }>(`SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key))?.mime_type ?? "image/png";
    const skillJunctionBound = async (agentId: string, skillId: string): Promise<boolean> => (await dbFirst(`SELECT 1 FROM lexa_agent_skills WHERE agent_id = ? AND skill_id = ? LIMIT 1`, agentId, skillId)) !== null;
    const getSettingsOrFail = (projectId: string) => settingsRepo.getByProject(projectId).pipe(Effect.catchTag("RowNotFound", () => new ProviderNotConfigured({ projectId })));
    const taskRefOf = (t: Task): TaskRef => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, dueAt: t.dueAt, archivedAt: t.archivedAt, markdown: docToMarkdown(t.description as TipTapDoc) });
    const loadDocContext = (projectId: string, documentType: "task" | "wiki", documentId: string): Effect.Effect<{ title: string; context: string }, TaskNotFound | WikiPageNotFound | DbError | RowNotFound> => Effect.gen(function* () {
      if (documentType === "task") { const t = yield* taskRepo.findById(documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: documentId }))); const md = docToMarkdown(t.description as TipTapDoc); return { title: t.title, context: `Task: ${t.key} — ${t.title}${md ? `\nDescription:\n${md}` : ""}` }; }
      const page = yield* wikiRepo.findBySlug(projectId, documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: documentId }))); const md = docToMarkdown(page.content as TipTapDoc); return { title: page.title, context: `Wiki page: ${page.title}${md ? `\n${md}` : ""}` };
    });
    // Project-scoped image loader: the blob read is gated on ownership by
    // `(project_id, storage_key)` across both attachment tables.
    const ownsImageStorageKey = async (projectId: string, key: string): Promise<boolean> =>
      (await dbFirst(`SELECT 1 FROM chat_attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key)) !== null ||
      (await dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, projectId, key)) !== null;
    const loadImageBase64For = (projectId: string) => async (key: string): Promise<string | null> => {
      if (!(await ownsImageStorageKey(projectId, key))) return null;
      return Effect.runPromise(Effect.map(storage.get(key), bytesToBase64)).catch(() => null);
    };
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
    // emission stays in the SAME batch as the status write (invariant #12).
    const completeTask = (id: string, result: string) =>
      runTerminal(id, "completed", result, null, "assistant_completed", (name) => msg.assistantCompleted(name));
    const failTask = (id: string, error: string) =>
      runTerminal(id, "failed", null, error, "assistant_failed", () => msg.assistantFailed());
    const cancelTask = (id: string) =>
      runTerminal(id, "cancelled", null, null, "assistant_cancelled", () => msg.assistantCancelled());

    return {
      activeTasks,
      activeDocuments,
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

      enqueue: (input: { projectId: string; documentType: "task" | "wiki"; documentId: string; prompt: string; agentId: string; skillId?: string; selection?: string; attachments?: Array<{ storageKey: string; mimeType: string; name: string }> }) => Effect.gen(function* () {
        // Per-document single-run guard (D6): a second live run on the same
        // document thread is refused 409 before a task row is created. The
        // authoritative guard is the stream's document lock (runStream); this
        // just fails fast for the common create-while-running case.
        if (activeDocuments.has(documentLockKey(input.projectId, input.documentType, input.documentId))) return yield* new AssistantTaskActive();
        const settingsRow = yield* getSettingsOrFail(input.projectId);
        yield* catalogRepo.findAgentById(input.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: input.agentId })));
        // Auto skill selection: an absent/blank skillId means the assistant picks
        // from its bound catalog itself. An explicit id is still validated
        // against the catalog AND the agent's junction binding.
        const skillId = input.skillId !== undefined && input.skillId.trim() !== "" ? input.skillId : null;
        if (skillId !== null) {
          yield* catalogRepo.findSkillById(skillId).pipe(Effect.catchTag("RowNotFound", () => new SkillNotFound({ id: skillId })));
          if (!(yield* Effect.promise(() => skillJunctionBound(input.agentId, skillId)))) return yield* new SkillNotFound({ id: skillId });
        }
        if (input.documentType === "task") yield* taskRepo.findById(input.documentId).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.documentId })));
        else yield* wikiRepo.findBySlug(input.projectId, input.documentId).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.documentId })));
        const attachments = input.attachments ?? [];
        if (attachments.length > 0) {
          yield* validateAttachments(input.projectId, attachments, DOC_IMAGE_CAPS);
          if (resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null }) === "none") return yield* new VisionNotConfigured();
          const existing = yield* threadRepo.loadThread(input.documentType, input.documentId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
          const verdict = resolveAssistantThread(existing, input.agentId);
          yield* threadRepo.saveThread(input.documentType, input.documentId, { projectId: input.projectId, agentId: input.agentId, skillId, messages: [...verdict.messages, { role: "user", content: attachments.map((a) => ({ type: "image-ref", storageKey: a.storageKey, mimeType: a.mimeType })) }], summary: verdict.summary, summarizedCount: verdict.summarizedCount });
        }
        return yield* queueRepo.createTask({ id: crypto.randomUUID(), projectId: input.projectId, documentType: input.documentType, documentId: input.documentId, agentId: input.agentId, skillId, extraPrompt: input.prompt, selection: input.selection ?? "" });
      }),
      resetThread: (projectId: string, documentType: "task" | "wiki", documentId: string) => Effect.gen(function* () {
        const tasks = yield* queueRepo.listTasksForDocument(projectId, documentType, documentId);
        if (tasks.some((t) => t.status === "running")) return yield* new AssistantTaskActive();
        yield* threadRepo.resetThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType, documentId })));
      }),
      runStream: (taskId: string, opts?: { userId?: string }) => {
        let docLock: { projectId: string; documentType: "task" | "wiki"; documentId: string; controller: AbortController } | null = null;
        return Effect.gen(function* () {
        const task = yield* queueRepo.claimAssistantTask(taskId).pipe(Effect.catchTag("ConstraintViolation", () => new AssistantTaskActive()), Effect.catchTag("RowNotFound", () => new AssistantTaskNotFound({ id: taskId })));
        // Register the run's AbortController BEFORE the setup awaits so a Stop /
        // client disconnect during setup is not a no-op (buildStream reuses it
        // via `existing ?? new AbortController()`). Mirrors tryAcquireChat.
        const controller = new AbortController();
        activeTasks.set(taskId, controller);
        // Per-document single-run lock (D6): the same controller is the lock, so
        // a second live run on this document thread is refused 409 rather than
        // racing the thread. The freshly-claimed row is settled failed so it
        // never sticks `running`.
        if (tryAcquireDocument(task.projectId, task.documentType, task.documentId, controller) === null) {
          activeTasks.delete(taskId);
          yield* failTask(taskId, "ASSISTANT_TASK_ACTIVE").pipe(Effect.catchAll(() => Effect.succeed(null)));
          return yield* new AssistantTaskActive();
        }
        docLock = { projectId: task.projectId, documentType: task.documentType, documentId: task.documentId, controller };
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
        // Auto mode: an omitted skill leaves `task.skillId` null, so no skill
        // markdown is injected and the assistant picks from its catalog.
        // Tolerant of a dangling `skill_id` (a skill deleted after enqueue):
        // degrade to auto mode, never fail the run.
        const taskSkillId = task.skillId;
        const skill = taskSkillId !== null
          ? yield* catalogRepo.findSkillById(taskSkillId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)))
          : null;
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
        const effectiveSelection = task.selection ?? "";
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
        // Bound-skill catalog: the same source `context.ts` uses, so the auto-pick
        // instruction has a catalog to reference on the Bun document path too.
        const boundSkills = yield* Effect.promise(() => dbAll<BoundSkill>(BOUND_SKILLS_SQL, task.agentId));
        const { skillCatalog } = buildSkillPromptParts(instruction, boundSkills);
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdowns: skill ? [skill.instructions] : [], skillCatalog, autoSkill: true, repoContent, docContext: doc.context, writeTools: enabledWriteTools, advisory: preflight.segment });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
        const baseTools = buildAssistantTools(buildToolDeps(task.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills));
        const writeSet = opts?.userId !== undefined ? buildWriteToolset(settingsRow, { projectId: task.projectId, documentType: task.documentType, documentId: task.documentId, ownerUserId: opts.userId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const mcp = yield* loadAssistantMcp(task.projectId, allowlist);
        const mcpTools = mcp?.tools ?? [];
        const visionConfig = imageMode === "delegate" ? yield* visionConfigOf(settingsRow) : null;
        const tools = visionConfig !== null ? [...baseTools, buildAnalyzeImageTool({ config: { ...visionConfig, sessionId: task.documentId }, loadImageBase64: loadImageBase64For(task.projectId), resolveMimeType: (key) => resolveMimeType(task.projectId, key), fetchImpl: fetch }), ...writeSet.tools, ...mcpTools] : [...baseTools, ...writeSet.tools, ...mcpTools];
        const userContent = buildUserMessage({ instruction, summary: verdict.summary, summarizedCount: verdict.summarizedCount }) as string;
        return buildStream({
          keyId: taskId, idField: "taskId", threadId: task.documentId, registry: activeTasks, config, gatewayStream: (input: unknown) => gateway.streamChat({ projectId: task.projectId, ...(input as object) } as never),
          systemPrompts, history: verdict.messages, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/assistant").AssistantReasoningEffort | null }).reasoning_effort)),
          historySummary: () => verdict.summary, historySummarizedCount: () => verdict.summarizedCount, userContent, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64: loadImageBase64For(task.projectId), imageMode, ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread(task.documentType, task.documentId, { projectId: task.projectId, agentId: task.agentId, skillId: task.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: (text) => Effect.runPromise(completeTask(taskId, text)).then(() => {}).catch(() => {}),
          onFail: (message) => Effect.runPromise(failTask(taskId, message)).then(() => {}).catch(() => {}),
          onCancel: async () => { await Effect.runPromise(cancelTask(taskId)).catch(() => {}); },
          // Release the document lock when the stream settles (success, error,
          // or abort); buildStream already dropped the abort registry entry.
          onDispose: async () => { try { if (mcp) await mcp.close(); } finally { releaseDocument(task.projectId, task.documentType, task.documentId, controller); } },
        });
        }).pipe(Effect.tapError(() => Effect.sync(() => {
          activeTasks.delete(taskId);
          if (docLock !== null) releaseDocument(docLock.projectId, docLock.documentType, docLock.documentId, docLock.controller);
        })));
      },
      resumeThreadStream: (documentType: "task" | "wiki", documentId: string) => {
        let docLock: { projectId: string; documentType: "task" | "wiki"; documentId: string; controller: AbortController } | null = null;
        return Effect.gen(function* () {
        const thread = yield* threadRepo.loadThread(documentType, documentId).pipe(Effect.catchTag("RowNotFound", () => new AssistantThreadNotFound({ documentType, documentId })));
        // Register the resume's AbortController before the setup awaits (a Stop
        // or disconnect during setup must not be a no-op) and take the
        // per-document lock (D6). buildStream reuses this controller
        // (keyId = documentId).
        const controller = new AbortController();
        activeTasks.set(documentId, controller);
        const release = () => {
          activeTasks.delete(documentId);
          releaseDocument(thread.projectId, documentType, documentId, controller);
        };
        if (tryAcquireDocument(thread.projectId, documentType, documentId, controller) === null) {
          release();
          return yield* new AssistantTaskActive();
        }
        docLock = { projectId: thread.projectId, documentType, documentId, controller };
        const tasks = yield* queueRepo.listTasksForDocument(thread.projectId, documentType, documentId);
        // A running row whose stream already died (lock released) is still a
        // conflict — keep the DB-level check alongside the in-memory lock.
        if (tasks.some((t) => t.status === "running")) {
          release();
          return yield* new AssistantTaskActive();
        }
        const settingsRow = yield* getSettingsOrFail(thread.projectId);
        // Claim BEFORE any work so a retry / second tab cannot re-execute the
        // same approved writes. `duplicate` no-ops; only a missing claim table
        // proceeds without a claim (`unclaimed`).
        const batchId = findPendingBatch(thread.messages);
        if (batchId === null) {
          release();
          return yield* new ApprovalsPending({ batchId: "", remaining: 0 });
        }
        const claim = yield* claimResumeBatch(db, batchId);
        if (claim === "duplicate") {
          release();
          return emptyFrameStream();
        }
        // Marker with no rows: nothing to execute — release and settle WITHOUT
        // a provider turn (parity with the chat resume path).
        const rows = yield* pendingWritesRepo.listByBatch(batchId);
        if (rows.length === 0) {
          yield* releaseResumeBatch(db, batchId);
          release();
          return emptyFrameStream();
        }
        const prepared = yield* Effect.either(prepareResume(thread));
        if (prepared._tag === "Left") {
          // Not executable (still pending / no marker): release so a later
          // attempt can resume it, then surface the same error as before.
          yield* releaseResumeBatch(db, batchId);
          release();
          return yield* Effect.fail(prepared.left);
        }
        const { messages: history, results: approvalResults, resumeResultsNote } = prepared.right;
        // Document-keyed thread: the agent is required; the skill is optional
        // (auto mode stores null, and skills are no longer thread-bound).
        if (!thread.agentId) return yield* new AgentNotFound({ id: "" });
        const agent = yield* catalogRepo.findAgentById(thread.agentId).pipe(Effect.catchTag("RowNotFound", () => new AgentNotFound({ id: thread.agentId ?? "" })));
        // Same tolerance as the new-run path: a deleted skill degrades the
        // resume to auto mode instead of aborting it.
        const threadSkillId = thread.skillId;
        const skill = threadSkillId !== null
          ? yield* catalogRepo.findSkillById(threadSkillId).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)))
          : null;
        const doc = yield* loadDocContext(thread.projectId, documentType, documentId);
        const repoContent = yield* loadTaskRepoContent({ projectId: thread.projectId, documentType, documentId } as Parameters<typeof loadTaskRepoContent>[0]).pipe(Effect.catchAll(() => Effect.succeed([])));
        const enabledWriteTools = parseWriteTools((settingsRow as unknown as { write_tools: string }).write_tools);
        const memoryHits = yield* memoryRepo.searchByProject(thread.projectId, extractMemoryTerms(doc.title, doc.context));
        // No preflight on resume: the judgment was made against the original
        // request. The tool is still offered — its budget is per stream. The
        // config is resolved once here too, so a resume gets the same gate.
        const jevConfig = yield* jevService.resolveForProject(thread.projectId);
        // Bound-skill catalog for the auto-pick instruction, same source as the
        // new-run path. A resume carries no new user text, so `$tokens` do not
        // apply here.
        const boundSkills = yield* Effect.promise(() => dbAll<BoundSkill>(BOUND_SKILLS_SQL, thread.agentId ?? ""));
        const { skillCatalog } = buildSkillPromptParts("", boundSkills);
        const systemPrompts = buildSystemPrompts({ identity: IDENTITY, memoryBlock: memoryBlockFromHits(memoryHits), agentMarkdown: agent.instructions, skillMarkdowns: skill ? [skill.instructions] : [], skillCatalog, autoSkill: true, repoContent, docContext: doc.context, writeTools: enabledWriteTools });
        const imageMode = resolveVisionMode({ primary_supports_images: (settingsRow as unknown as { primary_supports_images: number }).primary_supports_images, vision_model: (settingsRow as unknown as { vision_model?: string | null }).vision_model ?? null });
        const allowlist = (settingsRow as unknown as { url_allowlist: string | null }).url_allowlist;
        const baseTools = buildAssistantTools(buildToolDeps(thread.projectId, allowlist, (settingsRow as unknown as { search_api_key: string | null }).search_api_key, jevConfig, boundSkills));
        const writeSet = thread.ownerUserId !== null ? buildWriteToolset(settingsRow, { projectId: thread.projectId, documentType, documentId, ownerUserId: thread.ownerUserId }) : { tools: [] as unknown[], drain: undefined as (() => QueuedProposal[]) | undefined };
        const mcp = yield* loadAssistantMcp(thread.projectId, allowlist);
        const mcpTools = mcp?.tools ?? [];
        const visionConfig = imageMode === "delegate" ? yield* visionConfigOf(settingsRow) : null;
        const tools = visionConfig !== null ? [...baseTools, buildAnalyzeImageTool({ config: { ...visionConfig, sessionId: documentId }, loadImageBase64: loadImageBase64For(thread.projectId), resolveMimeType: (key) => resolveMimeType(thread.projectId, key), fetchImpl: fetch }), ...writeSet.tools, ...mcpTools] : [...baseTools, ...writeSet.tools, ...mcpTools];
        return buildStream({
          keyId: documentId, idField: "taskId", threadId: documentId, registry: activeTasks, config: configFromRow(settingsRow), gatewayStream: (input: unknown) => gateway.streamChat({ projectId: thread.projectId, ...(input as object) } as never),
          systemPrompts, history, userTs: new Date().toISOString(), getCitations: () => [], modelOptions: modelOptionsForEffort(resolveReasoningEffort((settingsRow as unknown as { reasoning_effort: import("../../shared/assistant").AssistantReasoningEffort | null }).reasoning_effort)),
          userContent: "", skipUserEntry: true, approvalResults, ...(resumeResultsNote !== "" ? { resumeResultsNote } : {}), ...(writeSet.drain ? { writeDrain: writeSet.drain } : {}), writeTools: enabledWriteTools, tools, toolRoundCap: MAX_TOOL_ROUNDS, loadImageBase64: loadImageBase64For(thread.projectId), imageMode, historySummary: () => thread.summary, historySummarizedCount: () => thread.summarizedCount,
          persist: (messages, summary, summarizedCount) => Effect.runPromise(threadRepo.saveThread(documentType, documentId, { projectId: thread.projectId, agentId: thread.agentId, skillId: thread.skillId, messages, summary, summarizedCount })).then(() => {}),
          onDone: () => Promise.resolve(), onFail: () => Promise.resolve(), onCancel: () => Promise.resolve(),
          // Release the document lock when the stream settles; buildStream
          // already dropped the abort registry entry.
          onDispose: async () => { try { if (mcp) await mcp.close(); } finally { release(); } },
        });
        }).pipe(Effect.tapError(() => Effect.sync(() => {
          activeTasks.delete(documentId);
          if (docLock !== null) releaseDocument(docLock.projectId, docLock.documentType, docLock.documentId, docLock.controller);
        })));
      },
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
