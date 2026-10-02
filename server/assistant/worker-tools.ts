// Worker-side read-tool executor (ADR-0003 §B.5/§D; P3 WS3).
//
// The DO owns the model-facing tool surface (`tools-ai.ts`); every read tool
// executes HERE, behind the HMAC internal-route boundary, where D1, R2 and the
// third-party keys (Exa, Jev) live. This module reuses the Bun path's tool
// implementations verbatim (`tools.ts` `buildAssistantTools`) so validation,
// caps and error copy stay byte-identical; only the dependency wiring is
// Worker-native (repos over the request-scoped `Db` layer, Storage over R2).
//
// Consumed by `server/workers-entry.ts` only — never imported by the DO.

import { Effect, Layer, ManagedRuntime } from "effect";
import type { DbDriver } from "../db/db";
import { Db, queryAll, queryFirst, type SqlParam } from "../db/db";
import type { RuntimeEnv } from "../env";
import { RuntimeEnvTag } from "../runtime-env";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ProjectMemoryRepo } from "../repos/project-memory.repo";
import { GitHubClient } from "../github/client";
import { Storage, StorageConfig } from "../storage/storage";
import type { R2Bucket as NarrowR2Bucket, StorageConfigShape } from "../storage/config";
import { AssistantJevService } from "../services/assistant-jev.service";
import { TaskService } from "../services/task.service";
import { CommentService } from "../services/comment.service";
import { WikiService } from "../services/wiki.service";
import { MilestoneService } from "../services/milestone.service";
import { SwimlaneService } from "../services/swimlane.service";
import { AuthorizationService } from "../services/authorization.service";
import { loadTaskRepoContent, type RepoContentEntry } from "../services/assistant-repo-content";
import { errorCodeMap } from "../api/errors";
import { applyAssistantWrite, type AssistantWriteApplyCtx } from "./write-execution";
import type { AssistantWriteToolName } from "./write-tool-names";
import { BOUND_SKILLS_SQL, matchBoundSkillByName } from "../services/assistant-helpers";
import { buildSkillPromptParts, resolveMentionContext, type MentionResolverDeps } from "./context";
import { docToMarkdown } from "../../shared/markdown";
import { extractMemoryTerms, memoryBlockFromHits } from "./prompt";
import { parseThreadKey } from "./agent-gate";
import { buildPreflightState, runJevPreflight, type JevPreflightResult } from "./jev";
import { parseWriteTools } from "./write-tools";
import { buildAssistantTools, type AssistantToolDeps, type BoundSkill } from "./tools";
import { resolveVisionMode } from "./vision";
import type { JevRuntimeConfig } from "./jev";
import type { ApprovalPartial } from "../../shared/assistant";
import type { ReadToolResponse, WriteExecuteResponse } from "./tools-ai";
import type { HarnessTurnContext, HarnessTurnContextRequest } from "./internal-routes";
import type { TipTapDoc } from "../../shared/types";

type BaseLayer = Layer.Layer<Db | RuntimeEnvTag>;

/** The 13 read-tool names, mirroring `tools-ai.ts` (`READ_TOOL_NAMES`). */
const READ_TOOL_NAMES = [
  "web_search",
  "fetch_url",
  "read_s3_file",
  "get_task",
  "search_tasks",
  "search_wiki",
  "read_wiki_page",
  "get_all_tasks",
  "get_all_wiki_pages",
  "get_board_structure",
  "get_skill",
  "analyze_image",
  "jev_assess",
] as const;

export interface WorkerTurnSettings {
  searchApiKey: string | null;
  urlAllowlist: string | null;
  writeTools: string[];
  primarySupportsImages: boolean;
}

export interface WorkerTurnContext {
  /** Read-tool names the DO may offer this turn (optional tools gated). */
  readTools: string[];
  writeTools: string[];
  primarySupportsImages: boolean;
  /** Boolean capability flags — never the Exa key / URL allowlist values. */
  hasSearchKey: boolean;
  jevConfigured: boolean;
}

interface SettingsRow {
  search_api_key: string | null;
  url_allowlist: string | null;
  write_tools: string;
  primary_supports_images: number;
}

export async function resolveWorkerSettings(driver: DbDriver, projectId: string): Promise<WorkerTurnSettings> {
  let row: SettingsRow | null = null;
  try {
    row = await Effect.runPromise(
      queryFirst<SettingsRow>(
        driver,
        `SELECT search_api_key, url_allowlist, write_tools, primary_supports_images
         FROM assistant_settings WHERE project_id = ?`,
        projectId
      )
    );
  } catch {
    row = null;
  }
  return {
    searchApiKey: row?.search_api_key && row.search_api_key !== "" ? row.search_api_key : null,
    urlAllowlist: row?.url_allowlist ?? null,
    writeTools: parseWriteTools(row?.write_tools),
    primarySupportsImages: row?.primary_supports_images === 1,
  };
}

export async function resolveWorkerBoundSkills(driver: DbDriver, agentId: string): Promise<BoundSkill[]> {
  try {
    return await Effect.runPromise(queryAll<BoundSkill>(driver, BOUND_SKILLS_SQL, agentId));
  } catch {
    return [];
  }
}

// Jev config resolution is delegated to the existing service (global enable +
// per-project opt-in + a decryptable stored key). Totally fail-open: any error
// is "no Jev" rather than a broken turn (ADR-0003 §D).
export async function resolveWorkerJevConfig(base: BaseLayer, projectId: string): Promise<JevRuntimeConfig | null> {
  // The service reads its env from the ambient context (`currentEnv`), and a
  // runtime's context is the layer's OUTPUT — so `RuntimeEnvTag` must ride on
  // the runtime too, not just be consumed while building the service. Without
  // it `currentEnv` falls back to `process.env`, which workerd does not
  // populate, and every keyring gate fails open.
  const runtime = ManagedRuntime.make(Layer.mergeAll(Layer.provide(AssistantJevService.Default, base), base));
  try {
    return await runtime.runPromise(
      Effect.flatMap(AssistantJevService, (s) => s.resolveForProject(projectId))
    );
  } catch {
    return null;
  } finally {
    await runtime.dispose();
  }
}

export interface WorkerTurnContextDeps {
  driver: DbDriver;
  base: BaseLayer;
  agentId?: string;
}

export async function resolveWorkerTurnContext(
  deps: WorkerTurnContextDeps,
  projectId: string
): Promise<WorkerTurnContext> {
  const [settings, boundSkills, jevConfig] = await Promise.all([
    resolveWorkerSettings(deps.driver, projectId),
    resolveWorkerBoundSkills(deps.driver, deps.agentId ?? "assistant"),
    resolveWorkerJevConfig(deps.base, projectId),
  ]);
  const available = new Set<string>(READ_TOOL_NAMES);
  if (settings.searchApiKey === null) available.delete("web_search");
  if (boundSkills.length === 0) available.delete("get_skill");
  if (jevConfig === null) available.delete("jev_assess");
  // Vision (docs/SCHEMA.md §Runtime): `primary_supports_images=1` → inline image
  // parts; the legacy `vision_model` column was dropped, so the delegate mode is
  // unreachable and `analyze_image` is never offered. The tool definition is
  // retained for parity (`tools-ai.ts` / `vision.ts`) — this is the documented
  // doc conflict reported to the maintainer; do not expand or delete it.
  const visionMode = resolveVisionMode({
    primary_supports_images: settings.primarySupportsImages,
    vision_model: null,
  });
  if (visionMode !== "delegate") available.delete("analyze_image");
  return {
    readTools: [...available],
    writeTools: settings.writeTools,
    primarySupportsImages: settings.primarySupportsImages,
    hasSearchKey: settings.searchApiKey !== null,
    jevConfigured: jevConfig !== null,
  };
}

// ── Per-turn harness context bundle (ADR-0004 §1; H1) ─────────────────────
// One Worker round trip per turn. Every step is fail-open except identity; a
// missing row/skill/agent degrades to a smaller block, never a failed turn.
// Redacted by construction: the Exa key / URL allowlist are consumed only to
// derive `hasSearchKey`, and never enter the returned bundle.

export interface WorkerHarnessContextDeps {
  driver: DbDriver;
  base: BaseLayer;
}

const HARNESS_PREFLIGHT_TIMEOUT_MS = 3_000;

function firstOf(driver: DbDriver) {
  return <T>(sql: string, ...params: unknown[]): Promise<T | null> =>
    Effect.runPromise(queryFirst<T>(driver, sql, ...(params as SqlParam[]))).catch(() => null);
}

function parseTipTap(raw: string | null | undefined): TipTapDoc {
  if (!raw) return { type: "doc", content: [] } as TipTapDoc;
  try {
    return JSON.parse(raw) as TipTapDoc;
  } catch {
    return { type: "doc", content: [] } as TipTapDoc;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function workerMentionDeps(deps: WorkerHarnessContextDeps): MentionResolverDeps {
  const dbFirst = firstOf(deps.driver);
  return {
    dbAll: async <T>(sql: string, ...params: unknown[]) => {
      try {
        return await Effect.runPromise(queryAll<T>(deps.driver, sql, ...(params as SqlParam[])));
      } catch {
        return [];
      }
    },
    findTaskByKey: async (key) => {
      const row = await dbFirst<{ id: string; project_id: string; key: string; title: string; description: string | null }>(
        `SELECT id, project_id, key, title, description FROM tasks WHERE key = ?`,
        key
      );
      if (!row) return null;
      return { id: row.id, projectId: row.project_id, key: row.key, title: row.title, description: parseTipTap(row.description) };
    },
    findWikiBySlug: async (projectId, slug) => {
      const row = await dbFirst<{ id: string; title: string; content: string | null }>(
        `SELECT id, title, content FROM wiki_pages WHERE project_id = ? AND slug = ?`,
        projectId,
        slug
      );
      if (!row) return null;
      return { id: row.id, title: row.title, content: parseTipTap(row.content) };
    },
  };
}

async function loadWorkerMemory(deps: WorkerHarnessContextDeps, projectId: string, terms: string[]): Promise<string[]> {
  try {
    const layer = Layer.provide(ProjectMemoryRepo.Default, deps.base);
    return await Effect.runPromise(
      Effect.provide(Effect.flatMap(ProjectMemoryRepo, (repo) => repo.searchByProject(projectId, terms)), layer)
    );
  } catch {
    return [];
  }
}

async function loadWorkerRepoContent(
  deps: WorkerHarnessContextDeps,
  documentType: "chat" | "task" | "wiki",
  documentId: string,
  projectId: string
): Promise<RepoContentEntry[]> {
  try {
    const layer = Layer.mergeAll(
      Layer.provide(TaskRepo.Default, deps.base),
      Layer.provide(ProjectReposRepo.Default, deps.base),
      GitHubClient.Default,
      deps.base
    );
    return await Effect.runPromise(
      Effect.provide(
        loadTaskRepoContent({ projectId, documentType, documentId } as Parameters<typeof loadTaskRepoContent>[0]),
        layer
      )
    );
  } catch {
    return [];
  }
}

async function runWorkerPreflight(
  deps: WorkerHarnessContextDeps,
  input: HarnessTurnContextRequest & { projectId: string },
  documentType: "chat" | "task" | "wiki",
  title: string | null,
  docContext: string | null,
  memoryHits: string[]
): Promise<string | null> {
  try {
    const config = await resolveWorkerJevConfig(deps.base, input.projectId);
    if (config === null) return null;
    const state = buildPreflightState({
      runKind: documentType === "chat" ? "chat" : "task",
      projectId: input.projectId,
      threadId: parseThreadKey(input.threadKey)?.documentId ?? input.threadKey,
      threadLabel: title,
      userMessage: input.userText,
      taskWikiContext: docContext,
      memoryHits,
    });
    const result: JevPreflightResult | null = await withTimeout(
      runJevPreflight({ state, config }),
      HARNESS_PREFLIGHT_TIMEOUT_MS
    );
    return result?.segment ?? null;
  } catch {
    return null;
  }
}

export async function resolveWorkerHarnessContext(
  deps: WorkerHarnessContextDeps,
  input: HarnessTurnContextRequest & { projectId: string }
): Promise<HarnessTurnContext> {
  const dbFirst = firstOf(deps.driver);
  const parsed = parseThreadKey(input.threadKey);
  const documentType: "chat" | "task" | "wiki" = parsed?.documentType ?? "chat";
  const documentId = parsed?.documentId ?? input.threadKey;

  const threadRow = await dbFirst<{
    agent_id: string | null;
    skill_id: string | null;
    summary: string | null;
    summarized_count: number;
    title: string | null;
  }>(
    `SELECT agent_id, skill_id, summary, summarized_count, title
     FROM assistant_threads WHERE document_type = ? AND document_id = ?`,
    documentType,
    documentId
  );

  // Agent: run row (document runs) wins over the thread row; fall back to the
  // builtin `assistant` row and finally a synthetic blank agent.
  let agentId = threadRow?.agent_id ?? null;
  if (input.runId) {
    const runRow = await dbFirst<{ agent_id: string }>(`SELECT agent_id FROM assistant_tasks WHERE id = ?`, input.runId);
    if (runRow?.agent_id) agentId = runRow.agent_id;
  }
  const agentRow = agentId
    ? await dbFirst<{ id: string; name: string; instructions: string }>(
        `SELECT id, name, instructions FROM lexa_agents WHERE id = ?`,
        agentId
      )
    : null;
  const builtinRow = agentRow
    ? null
    : await dbFirst<{ id: string; name: string; instructions: string }>(
        `SELECT id, name, instructions FROM lexa_agents WHERE id = 'assistant'`
      );
  const agent = agentRow
    ? { id: agentRow.id, name: agentRow.name, instructions: agentRow.instructions }
    : builtinRow
      ? { id: builtinRow.id, name: builtinRow.name, instructions: builtinRow.instructions }
      : { id: "assistant", name: "Assistant Agent", instructions: "" };

  // Skills: ≤3 `$tokens` against the resolved agent's bound skills (catalog
  // ≤20). Task/wiki use the thread's bound skillId as the first markdown.
  const boundSkills = await resolveWorkerBoundSkills(deps.driver, agent.id);
  const parts = buildSkillPromptParts(input.userText, boundSkills);
  if (documentType !== "chat" && threadRow?.skill_id) {
    const skill = await dbFirst<{ name: string; instructions: string | null }>(
      `SELECT name, instructions FROM lexa_skills WHERE id = ?`,
      threadRow.skill_id
    );
    if (skill && (skill.instructions ?? "").trim() !== "") {
      parts.skillMarkdowns = [`## Skill: ${skill.name}\n${skill.instructions}`, ...parts.skillMarkdowns].slice(0, 3);
    }
  }

  // Doc context: task/wiki only. Chat carries no document body.
  let docContext: string | null = null;
  if (documentType === "task") {
    const task = await dbFirst<{ key: string; title: string; description: string | null }>(
      `SELECT key, title, description FROM tasks WHERE id = ? AND project_id = ?`,
      documentId,
      input.projectId
    );
    if (task) {
      const md = docToMarkdown(parseTipTap(task.description));
      docContext = `Task: ${task.key} — ${task.title}${md ? `\nDescription:\n${md}` : ""}`;
    }
  } else if (documentType === "wiki") {
    const page = await dbFirst<{ title: string; content: string | null }>(
      `SELECT title, content FROM wiki_pages WHERE project_id = ? AND slug = ?`,
      input.projectId,
      documentId
    );
    if (page) {
      const md = docToMarkdown(parseTipTap(page.content));
      docContext = `Wiki page: ${page.title}${md ? `\n${md}` : ""}`;
    }
  }

  // Repo content: task/wiki only; chat = no prefetch (wireframe contract).
  const repoContent =
    documentType === "chat" ? [] : await loadWorkerRepoContent(deps, documentType, documentId, input.projectId);

  // Memory: FTS K=5 / 2000-char cap via the shared repo.
  const memoryHits = await loadWorkerMemory(deps, input.projectId, extractMemoryTerms(input.userText, ""));
  const memoryBlock = memoryBlockFromHits(memoryHits);

  // Mention context: chat only (task/wiki carry their own doc context).
  let mentionContext: string | null = null;
  if (documentType === "chat") {
    const block = await resolveMentionContext(workerMentionDeps(deps), input.projectId, input.userText);
    mentionContext = block.trim() !== "" ? block : null;
  }

  // Tool gating: names + booleans only; secrets stay Worker-side.
  const gating = await resolveWorkerTurnContext({ driver: deps.driver, base: deps.base }, input.projectId);

  // Jev preflight: advisory, fail-open, skipped on resume, 3s cap (R2).
  const advisory =
    input.mode === "resume"
      ? null
      : await runWorkerPreflight(deps, input, documentType, threadRow?.title ?? null, docContext, memoryHits);

  const summary = threadRow?.summary && threadRow.summary.trim() !== "" ? threadRow.summary : null;
  return {
    projectId: input.projectId,
    threadKey: input.threadKey,
    documentType,
    agent,
    skillMarkdowns: parts.skillMarkdowns,
    skillCatalog: parts.skillCatalog,
    memoryBlock,
    docContext,
    repoContent,
    mentionContext,
    advisory,
    threadSummary: summary !== null ? { summary, summarizedCount: threadRow?.summarized_count ?? 0 } : null,
    readTools: gating.readTools,
    mcpTools: [],
    writeTools: gating.writeTools,
    primarySupportsImages: gating.primarySupportsImages,
    hasSearchKey: gating.hasSearchKey,
    jevConfigured: gating.jevConfigured,
    delegation: { enabled: false, maxConcurrentRuns: 0 },
  };
}

function taskSummary(t: {
  id: string;
  key: string;
  title: string;
  priority: string;
  dueAt: string | null;
  archivedAt: string | null;
  description: unknown;
}) {
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    priority: t.priority,
    dueAt: t.dueAt,
    archivedAt: t.archivedAt,
    markdown: docToMarkdown(t.description as never),
  };
}

export interface WorkerReadToolExecutorInput {
  name: string;
  args: Record<string, unknown>;
  projectId: string;
}

interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface WorkerReadToolExecutorDeps {
  driver: DbDriver;
  base: BaseLayer;
  blob?: R2BucketLike | undefined;
}

function storageConfigFor(blob: R2BucketLike | undefined): StorageConfigShape {
  return {
    driver: "r2",
    fsRoot: "",
    s3: null,
    r2: blob ? { binding: blob as unknown as NarrowR2Bucket, bucketName: "lexa-blobs" } : null,
    maxUploadBytes: 0,
  };
}

/**
 * Build the per-request read-tool executor. Each call resolves the project's
 * settings/Jev/skills and assembles the same `AssistantToolDeps` the Bun path
 * uses, then dispatches to the matching `buildAssistantTools` entry.
 */
export function buildWorkerReadToolExecutor(
  deps: WorkerReadToolExecutorDeps
): (input: WorkerReadToolExecutorInput) => Promise<ReadToolResponse> {
  const dataLayer = Layer.mergeAll(
    Layer.provide(TaskRepo.Default, deps.base),
    Layer.provide(WikiRepo.Default, deps.base),
    Layer.provide(Storage.Default, Layer.mergeAll(deps.base, Layer.succeed(StorageConfig, storageConfigFor(deps.blob))))
  ) as Layer.Layer<TaskRepo | WikiRepo | Storage>;
  // `Effect.provide` builds + finalizes the layer per call, so the per-request
  // repos/Storage runtime is never leaked (reviewer NIT: a ManagedRuntime here
  // was never disposed).
  const runData = <A, E>(effect: Effect.Effect<A, E, TaskRepo | WikiRepo | Storage>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, dataLayer));
  const dbFirst = <T>(sql: string, ...params: unknown[]): Promise<T | null> =>
    Effect.runPromise(queryFirst<T>(deps.driver, sql, ...params)).catch(() => null);
  const dbAll = <T>(sql: string, ...params: unknown[]): Promise<T[]> =>
    Effect.runPromise(queryAll<T>(deps.driver, sql, ...params)).catch(() => []);

  return async (input) => {
    try {
      const [settings, boundSkills, jevConfig] = await Promise.all([
        resolveWorkerSettings(deps.driver, input.projectId),
        resolveWorkerBoundSkills(deps.driver, "assistant"),
        resolveWorkerJevConfig(deps.base, input.projectId),
      ]);
      const toolDeps: AssistantToolDeps = {
        projectId: input.projectId,
        allowlist: settings.urlAllowlist,
        searchApiKey: settings.searchApiKey,
        jevConfig,
        fetchImpl: fetch,
        ...(boundSkills.length > 0
          ? { loadSkillByName: async (name: string): Promise<BoundSkill | null> => matchBoundSkillByName(boundSkills, name) }
          : {}),
        storageGet: (key: string) => runData(Effect.flatMap(Storage, (s) => s.get(key))),
        projectOwnsStorageKey: (pid: string, key: string) =>
          dbFirst(`SELECT 1 FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`, pid, key).then(
            (r) => r !== null
          ),
        findTaskByRef: async (ref: string) => {
          const t = await runData(
              Effect.gen(function* () {
                const repo = yield* TaskRepo;
                return yield* repo.findById(ref).pipe(Effect.orElse(() => repo.findByKey(ref)));
              })
            )
            .catch(() => null);
          if (!t || t.projectId !== input.projectId) return null;
          const [col, lane] = await Promise.all([
            dbFirst<{ name: string }>(`SELECT name FROM columns WHERE id = ?`, t.columnId),
            dbFirst<{ name: string; milestone_id: string | null }>(
              `SELECT name, milestone_id FROM swimlanes WHERE id = ?`,
              t.swimlaneId
            ),
          ]);
          let milestoneName: string | null = null;
          if (lane?.milestone_id) {
            const m = await dbFirst<{ name: string }>(`SELECT name FROM milestones WHERE id = ?`, lane.milestone_id);
            milestoneName = m?.name ?? null;
          }
          return {
            id: t.id,
            key: t.key,
            title: t.title,
            priority: t.priority,
            dueAt: t.dueAt,
            archivedAt: t.archivedAt,
            markdown: docToMarkdown(t.description as never),
            columnName: col?.name ?? "",
            swimlaneName: lane?.name ?? "",
            milestoneName,
            type: t.type,
            assignees: t.assignees,
            githubIssue: null,
          };
        },
        searchTasksByTitle: async (query: string, limit = 10) => {
          const rows = await runData(Effect.flatMap(TaskRepo, (repo) => repo.searchByTitle(input.projectId, query, limit)))
            .catch(() => []);
          return (rows as Array<Parameters<typeof taskSummary>[0]>).map(taskSummary);
        },
        searchWikiPages: async (query: string, limit = 10) => {
          const rows = await runData(Effect.flatMap(WikiRepo, (repo) => repo.search(input.projectId, query, limit)))
            .catch(() => []);
          return (rows as Array<{ title: string; slug: string; snippet: string }>).map((p) => ({
            title: p.title,
            slug: p.slug,
            snippet: p.snippet,
          }));
        },
        findWikiPageBySlug: async (slug: string) => {
          const page = await runData(Effect.flatMap(WikiRepo, (repo) => repo.findBySlug(input.projectId, slug)))
            .catch(() => null);
          if (!page) return null;
          return {
            title: page.title,
            slug: page.slug,
            content: page.content,
          };
        },
        listAllTasks: async () => {
          const rows = await runData(Effect.flatMap(TaskRepo, (repo) => repo.listByProject(input.projectId)))
            .catch(() => []);
          return (rows as Array<Parameters<typeof taskSummary>[0]>).map(taskSummary);
        },
        listWikiPagesFull: async () => {
          const rows = await runData(Effect.flatMap(WikiRepo, (repo) => repo.findFullByProject(input.projectId)))
            .catch(() => []);
          return (rows as Array<{ title: string; slug: string; content: never }>).map((p) => ({
            title: p.title,
            slug: p.slug,
            content: p.content,
          }));
        },
        getBoardStructure: async () => {
          const columns = (
            await dbAll<{
              id: string;
              name: string;
              position: number;
              wip_limit: number | null;
              github_state: "open" | "closed" | null;
              is_done: number;
            }>(
              `SELECT id, name, position, wip_limit, github_state, is_done FROM columns WHERE project_id = ? ORDER BY position`,
              input.projectId
            )
          ).map((c) => ({
            id: c.id,
            name: c.name,
            position: c.position,
            wipLimit: c.wip_limit,
            githubState: c.github_state,
            isDone: c.is_done !== 0,
          }));
          const swimlanes = (
            await dbAll<{
              id: string;
              name: string;
              kind: "backlog" | "sprint";
              start_at: string | null;
              due_at: string | null;
              archived_at: string | null;
              milestone_id: string | null;
            }>(
              `SELECT id, name, kind, start_at, due_at, archived_at, milestone_id FROM swimlanes WHERE project_id = ? ORDER BY position`,
              input.projectId
            )
          ).map((l) => ({
            id: l.id,
            name: l.name,
            kind: l.kind,
            startAt: l.start_at,
            dueAt: l.due_at,
            archived: l.archived_at !== null,
            milestoneId: l.milestone_id,
          }));
          const milestones = (
            await dbAll<{ id: string; name: string; due_at: string | null; archived_at: string | null }>(
              `SELECT id, name, due_at, archived_at FROM milestones WHERE project_id = ? ORDER BY position`,
              input.projectId
            )
          ).map((m) => ({ id: m.id, name: m.name, dueAt: m.due_at, archived: m.archived_at !== null }));
          return { columns, swimlanes, milestones };
        },
      };
      const tools = buildAssistantTools(toolDeps) as unknown as Array<{
        name: string;
        execute?: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
      const tool = tools.find((t) => t.name === input.name);
      if (!tool?.execute) {
        return { ok: false, error: `unknown read tool: ${input.name}` };
      }
      const result = await tool.execute(input.args ?? {});
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "tool execution failed" };
    }
  };
}

// ── Auto-mode write executor (D4) ──────────────────────────────────────────
// Mirrors the read executor: the Worker owns the domain switch (`applyAssistantWrite`)
// behind the HMAC route, building the same service graph the Bun path uses over
// the request's Db/RuntimeEnv layers. The route only forwards identity-verified
// input; args are already schema-validated DO-side.

export interface WorkerWriteToolExecutorInput {
  name: string;
  args: Record<string, unknown>;
  projectId: string;
  ownerUserId: string;
}

function partialOf(result: unknown): { partial?: ApprovalPartial } {
  const failed = (result as { failed?: unknown } | null | undefined)?.failed;
  const applied = (result as { applied?: unknown } | null | undefined)?.applied;
  if (!Array.isArray(failed) || failed.length === 0) return {};
  return {
    partial: {
      applied: Array.isArray(applied) ? applied.length : 0,
      failed: failed.length,
      errors: failed
        .map((f) => (f as { error?: unknown } | null | undefined)?.error)
        .filter((e): e is string => typeof e === "string"),
    },
  };
}

export function buildWorkerWriteToolExecutor(deps: {
  base: BaseLayer;
}): (input: WorkerWriteToolExecutorInput) => Promise<WriteExecuteResponse> {
  const services = Layer.mergeAll(
    TaskService.Default,
    CommentService.Default,
    WikiService.Default,
    MilestoneService.Default,
    SwimlaneService.Default,
    AuthorizationService.Default,
    TaskRepo.Default,
    WikiRepo.Default
  );
  // `Db` rides the base layer, so `driver` is not a dependency here. The layer
  // is provided per call and finalized after it, mirroring the read executor
  // (reviewer NIT: the previous ManagedRuntime was never disposed).
  const layer = Layer.mergeAll(Layer.provide(services, deps.base), deps.base);
  return async (input) => {
    try {
      return await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const db = yield* Db;
            const taskService = yield* TaskService;
            const commentService = yield* CommentService;
            const wikiService = yield* WikiService;
            const milestoneService = yield* MilestoneService;
            const swimlaneService = yield* SwimlaneService;
            const authz = yield* AuthorizationService;
            const taskRepo = yield* TaskRepo;
            const wikiRepo = yield* WikiRepo;
            const ctx: AssistantWriteApplyCtx = {
              db,
              taskService,
              commentService,
              wikiService,
              milestoneService,
              swimlaneService,
              authz,
              taskRepo,
              wikiRepo,
            };
            const outcome = yield* applyAssistantWrite(
              {
                toolName: input.name as AssistantWriteToolName,
                args: input.args,
                projectId: input.projectId,
                ownerUserId: input.ownerUserId,
              },
              ctx
            ).pipe(Effect.either);
            if (outcome._tag === "Left") {
              const err = outcome.left as { _tag?: string; message?: string };
              const code = errorCodeMap[err._tag ?? ""] ?? "ASSISTANT_WRITE_FAILED";
              return {
                ok: false,
                applied: false,
                error: `${code}: ${String(err.message ?? "write failed")}`.slice(0, 2000),
              } satisfies WriteExecuteResponse;
            }
            return {
              ok: true,
              applied: true,
              result: outcome.right,
              ...partialOf(outcome.right),
            } satisfies WriteExecuteResponse;
          }),
          layer
        )
      );
    } catch (e) {
      return { ok: false, applied: false, error: e instanceof Error ? e.message : "write failed" };
    }
  };
}
