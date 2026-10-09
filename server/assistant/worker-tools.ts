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
import { isChatImageMime } from "../storage/mime";
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
import { BOUND_SKILLS_SQL, bytesToBase64, extractDocumentText, matchBoundSkillByName } from "../services/assistant-helpers";
import { buildSkillPromptParts, resolveMentionContext, type MentionResolverDeps } from "./context";
import { discoverMcpDescriptors, executeMcpTool } from "./mcp-descriptors";
import { docToMarkdown } from "../../shared/markdown";
import { extractMemoryTerms, memoryBlockFromHits } from "./prompt";
import { PROJECT_RUN_LIMIT } from "./delegation";
import { parseThreadKey } from "./agent-gate";
import { buildPreflightState, runJevPreflight, type JevPreflightResult } from "./jev";
import { parseWriteTools } from "./write-tools";
import { buildAssistantTools, type AssistantToolDeps, type BoundSkill } from "./tools";
import { buildAnalyzeImageTool, resolveVisionMode } from "./vision";
import type { ProviderConfig } from "./provider";
import { AssistantProvidersService } from "../services/assistant-providers.service";
import type { JevRuntimeConfig } from "./jev";
import type { ApprovalPartial } from "../../shared/assistant";
import type { ReadToolResponse, WriteExecuteResponse } from "./tools-ai";
import type { AttachmentContent, HarnessTurnContext, HarnessTurnContextRequest } from "./internal-routes";
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
  /** Primary provider binding — the vision agent resolves against it. */
  providerId: string | null;
  /** Configured vision agent model id, or null when unset (the default). */
  visionModel: string | null;
}

export interface WorkerTurnContext {
  /** Read-tool names the DO may offer this turn (optional tools gated). */
  readTools: string[];
  writeTools: string[];
  primarySupportsImages: boolean;
  /** The configured vision agent model id, or null when unset. */
  visionModel: string | null;
  /** Boolean capability flags — never the Exa key / URL allowlist values. */
  hasSearchKey: boolean;
  jevConfigured: boolean;
}

interface SettingsRow {
  search_api_key: string | null;
  url_allowlist: string | null;
  write_tools: string;
  primary_supports_images: number;
  provider_id: string | null;
  vision_model: string | null;
}

export async function resolveWorkerSettings(driver: DbDriver, projectId: string): Promise<WorkerTurnSettings> {
  let row: SettingsRow | null = null;
  try {
    row = await Effect.runPromise(
      queryFirst<SettingsRow>(
        driver,
        `SELECT search_api_key, url_allowlist, write_tools, primary_supports_images, provider_id, vision_model
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
    providerId: row?.provider_id ?? null,
    visionModel: row?.vision_model && row.vision_model !== "" ? row.vision_model : null,
  };
}

export async function resolveWorkerBoundSkills(driver: DbDriver, agentId: string): Promise<BoundSkill[]> {
  try {
    return await Effect.runPromise(queryAll<BoundSkill>(driver, BOUND_SKILLS_SQL, agentId));
  } catch {
    return [];
  }
}

/**
 * Dark-launch gate for delegation (ADR-0004 §3; H3). Reads the GLOBAL
 * `assistant_delegation_enabled` setting and defaults OFF: any missing row,
 * unreadable DB or unrecognized value keeps `spawn_run`/`check_run` off every
 * chat surface. H5 flips it on.
 */
export async function resolveWorkerDelegationEnabled(driver: DbDriver): Promise<boolean> {
  try {
    const row = await Effect.runPromise(
      queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = 'assistant_delegation_enabled'")
    );
    const value = (row?.value ?? "").trim().toLowerCase();
    return value === "1" || value === "true";
  } catch {
    return false;
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
  // Vision (docs/SCHEMA.md §Runtime): a configured `vision_model` → delegate, so
  // `analyze_image` is offered; no vision model (with a text-only primary) → the
  // tool is dropped. CURRENT PHASE: delegate wins whenever a vision model is set.
  const visionMode = resolveVisionMode({
    primary_supports_images: settings.primarySupportsImages,
    vision_model: settings.visionModel,
  });
  if (visionMode !== "delegate") available.delete("analyze_image");
  return {
    readTools: [...available],
    writeTools: settings.writeTools,
    primarySupportsImages: settings.primarySupportsImages,
    visionModel: settings.visionModel,
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
  /** Runtime env (Workers bindings) for MCP discovery; absent = MCP disabled. */
  env?: RuntimeEnv | null | undefined;
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
    summary: string | null;
    summarized_count: number;
    title: string | null;
  }>(
    `SELECT agent_id, summary, summarized_count, title
     FROM assistant_threads WHERE document_type = ? AND document_id = ?`,
    documentType,
    documentId
  );

  // Agent: run row (document runs) wins over the thread row; fall back to the
  // builtin `assistant` row and finally a synthetic blank agent. The run row is
  // also the skill source (below): `assistant_tasks` is the document run's
  // source of truth, so `runRow` is kept in scope.
  let agentId = threadRow?.agent_id ?? null;
  let runRow: { agent_id: string; skill_id: string | null } | null = null;
  if (input.runId) {
    runRow = await dbFirst<{ agent_id: string; skill_id: string | null }>(
      `SELECT agent_id, skill_id FROM assistant_tasks WHERE id = ? AND project_id = ?`,
      input.runId,
      input.projectId
    );
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
  // ≤20). A document run's pre-selected skill comes from the RUN row
  // (`assistant_tasks.skill_id`), never the thread: auto mode stores a null run
  // skill, so a stale thread-bound skill must not leak in. Chat turns, and
  // delegated runners with no task row, carry no run skill. Explicit `$name`
  // tokens keep resolving from `buildSkillPromptParts` regardless.
  const boundSkills = await resolveWorkerBoundSkills(deps.driver, agent.id);
  const parts = buildSkillPromptParts(input.userText, boundSkills);
  if (documentType !== "chat" && runRow?.skill_id) {
    const skill = await dbFirst<{ name: string; instructions: string | null }>(
      `SELECT name, instructions FROM lexa_skills WHERE id = ?`,
      runRow.skill_id
    );
    if (skill && (skill.instructions ?? "").trim() !== "") {
      // Dedupe by name: an explicit `$name` mention of the same run-row skill
      // already produced identical markdown — do not prepend it twice.
      const markdown = `## Skill: ${skill.name}\n${skill.instructions}`;
      const alreadyMentioned = parts.skillMarkdowns.some((m) => m.startsWith(`## Skill: ${skill.name}\n`));
      if (!alreadyMentioned) {
        parts.skillMarkdowns = [markdown, ...parts.skillMarkdowns].slice(0, 3);
      }
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

  // Memory: FTS K=5 / 2000-char cap via the shared repo. Task/wiki terms come
  // from the document title + assembled context so a doc-body question still
  // recalls the right facts; chat falls back to the thread title + user text.
  const memoryTitle = threadRow?.title ?? "";
  const memoryBody = documentType === "chat" ? input.userText : `${input.userText}\n${docContext ?? ""}`;
  const memoryHits = await loadWorkerMemory(deps, input.projectId, extractMemoryTerms(memoryTitle, memoryBody));
  const memoryBlock = memoryBlockFromHits(memoryHits);

  // Mention context: chat only (task/wiki carry their own doc context).
  let mentionContext: string | null = null;
  if (documentType === "chat") {
    const block = await resolveMentionContext(workerMentionDeps(deps), input.projectId, input.userText);
    mentionContext = block.trim() !== "" ? block : null;
  }

  // Tool gating: names + booleans only; secrets stay Worker-side. The resolved
  // agent id gates bound-skill tools (never the literal "assistant").
  const gating = await resolveWorkerTurnContext({ driver: deps.driver, base: deps.base, agentId: agent.id }, input.projectId);

  // MCP descriptors (ADR-0004 §5; H6): read-only, default-deny, cached ~60s
  // Worker-side. Secrets/clients never cross to the DO — descriptors only.
  const settings = await resolveWorkerSettings(deps.driver, input.projectId);
  const mcpTools = await discoverMcpDescriptors({
    driver: deps.driver,
    env: deps.env ?? null,
    allowlist: settings.urlAllowlist,
    projectId: input.projectId,
  });

  // Jev preflight: advisory, fail-open, skipped on resume, 3s cap (R2).
  const advisory =
    input.mode === "resume"
      ? null
      : await runWorkerPreflight(deps, input, documentType, threadRow?.title ?? null, docContext, memoryHits);

  const summary = threadRow?.summary && threadRow.summary.trim() !== "" ? threadRow.summary : null;
  const delegationEnabled = await resolveWorkerDelegationEnabled(deps.driver);
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
    mcpTools,
    writeTools: gating.writeTools,
    primarySupportsImages: gating.primarySupportsImages,
    visionModel: gating.visionModel,
    hasSearchKey: gating.hasSearchKey,
    jevConfigured: gating.jevConfigured,
    delegation: { enabled: delegationEnabled, maxConcurrentRuns: PROJECT_RUN_LIMIT },
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
  /** Resolved agent id (H1 nit): gates bound-skill tools for the right agent. */
  agentId?: string | undefined;
}

interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface WorkerReadToolExecutorDeps {
  driver: DbDriver;
  base: BaseLayer;
  blob?: R2BucketLike | undefined;
  /** Runtime env for MCP dispatch; absent = MCP unavailable (fail-open). */
  env?: RuntimeEnv | null | undefined;
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

// ── Repo read tools (ADR-0004 §5; H6) ──────────────────────────────────────
// Source-role repos only, capped by the `assistant_repo_cap` setting (same
// source the prefetch uses). Read-only; every failure is a typed tool error the
// model can recover from.

const REPO_READ_MAX_FILES = 500;
const REPO_READ_MAX_BYTES = 120_000;
const REPO_READ_DEFAULT_CAP = 3;

async function readRepoCap(driver: DbDriver): Promise<number> {
  const row = await Effect.runPromise(
    queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = 'assistant_repo_cap'")
  ).catch(() => null);
  const parsed = Number(row?.value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 10) : REPO_READ_DEFAULT_CAP;
}

function repoReadLayer(base: BaseLayer): Layer.Layer<ProjectReposRepo | GitHubClient> {
  return Layer.mergeAll(Layer.provide(ProjectReposRepo.Default, base), GitHubClient.Default);
}

async function sourceRepos(deps: WorkerReadToolExecutorDeps, projectId: string): Promise<string[]> {
  const rows = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(ProjectReposRepo, (repo) => repo.listByProject(projectId)).pipe(Effect.catchAll(() => Effect.succeed([]))),
      repoReadLayer(deps.base)
    )
  ).catch(() => []);
  return rows.filter((row) => row.sourceRole).map((row) => row.repo);
}

async function listWorkerRepoFiles(
  deps: WorkerReadToolExecutorDeps,
  projectId: string
): Promise<ReadToolResponse> {
  try {
    const cap = await readRepoCap(deps.driver);
    const repos = (await sourceRepos(deps, projectId)).slice(0, cap);
    if (repos.length === 0) return { ok: true, result: { repos: [], files: [], truncated: false } };
    const files = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* GitHubClient;
          const out: Array<{ repo: string; path: string; size: number | null }> = [];
          for (const full of repos) {
            const [owner, name] = full.split("/");
            if (!owner || !name) continue;
            const branch = yield* client.getDefaultBranch(owner, name).pipe(Effect.catchAll(() => Effect.succeed("")));
            if (branch === "") continue;
            const tree = yield* client
              .getRepoFileTree(owner, name, branch)
              .pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ path: string; type: string; size?: number }>)));
            for (const entry of tree) {
              if (entry.type !== "blob") continue;
              if (out.length >= REPO_READ_MAX_FILES) break;
              out.push({ repo: full, path: entry.path, size: entry.size ?? null });
            }
          }
          return out;
        }),
        repoReadLayer(deps.base)
      )
    );
    return { ok: true, result: { repos, files, truncated: files.length >= REPO_READ_MAX_FILES } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "repo listing failed" };
  }
}

async function readWorkerRepoFile(
  deps: WorkerReadToolExecutorDeps,
  projectId: string,
  args: Record<string, unknown>
): Promise<ReadToolResponse> {
  const repo = typeof args.repo === "string" ? args.repo : "";
  const path = typeof args.path === "string" ? args.path : "";
  if (repo === "" || path === "") return { ok: false, error: "repo and path are required" };
  try {
    const cap = await readRepoCap(deps.driver);
    const repos = (await sourceRepos(deps, projectId)).slice(0, cap);
    if (!repos.includes(repo)) return { ok: false, error: `repo ${repo} is not a source-role repo for this project` };
    const [owner, name] = repo.split("/");
    if (!owner || !name) return { ok: false, error: `invalid repo ${repo}` };
    const content = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* GitHubClient;
          const branch = yield* client.getDefaultBranch(owner, name).pipe(Effect.catchAll(() => Effect.succeed("")));
          if (branch === "") return "";
          return yield* client.getRepoFileContent(owner, name, path).pipe(Effect.catchAll(() => Effect.succeed("")));
        }),
        repoReadLayer(deps.base)
      )
    );
    if (content === "") return { ok: false, error: `file ${path} not found in ${repo}` };
    return {
      ok: true,
      result: { repo, path, content: content.slice(0, REPO_READ_MAX_BYTES), truncated: content.length > REPO_READ_MAX_BYTES },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "repo read failed" };
  }
}

// ── Vision agent (analyze_image) ───────────────────────────────────────────
// The DO's `analyze_image` read tool executes HERE: the Worker owns the provider
// key (decrypted per call) and blob storage, so the model's image question is
// answered by the project's configured vision model through the same
// `analyzeImage` wire formats the Bun path used. Returns null when vision is
// unconfigured or the provider key cannot be resolved — the tool is then simply
// absent (the DO only offers `analyze_image` when the Worker reports it).
async function resolveWorkerVisionTool(
  deps: WorkerReadToolExecutorDeps,
  settings: WorkerTurnSettings,
  loadImageBase64: (key: string) => Promise<string | null>,
  resolveMimeType: (key: string) => Promise<string>
): Promise<ReturnType<typeof buildAnalyzeImageTool> | null> {
  const visionModel = settings.visionModel;
  const providerId = settings.providerId;
  if (visionModel === null || providerId === null) return null;
  try {
    const [modelRow, providerRow] = await Promise.all([
      Effect.runPromise(
        queryFirst<{ kind: ProviderConfig["kind"] }>(
          deps.driver,
          `SELECT kind FROM assistant_models WHERE provider_id = ? AND model_id = ? LIMIT 1`,
          providerId,
          visionModel
        )
      ).catch(() => null),
      Effect.runPromise(
        queryFirst<{ base_url: string }>(deps.driver, `SELECT base_url FROM assistant_providers WHERE id = ?`, providerId)
      ).catch(() => null),
    ]);
    if (!modelRow || !providerRow) return null;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(Layer.provide(AssistantProvidersService.Default, deps.base), deps.base)
    );
    let apiKey = "";
    try {
      apiKey = await runtime.runPromise(Effect.flatMap(AssistantProvidersService, (s) => s.resolveApiKey(providerId)));
    } catch {
      return null;
    } finally {
      await runtime.dispose();
    }
    return buildAnalyzeImageTool({
      config: { kind: modelRow.kind, baseUrl: providerRow.base_url, apiKey, model: visionModel },
      loadImageBase64,
      resolveMimeType,
      fetchImpl: fetch,
    });
  } catch {
    return null;
  }
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
        resolveWorkerBoundSkills(deps.driver, input.agentId && input.agentId.length > 0 ? input.agentId : "assistant"),
        resolveWorkerJevConfig(deps.base, input.projectId),
      ]);
      // MCP dispatch (H6): prefixed calls execute through the read-only bridge.
      if (input.name.startsWith("mcp__")) {
        return await executeMcpTool(
          { driver: deps.driver, env: deps.env ?? null, allowlist: settings.urlAllowlist, projectId: input.projectId },
          input.name,
          input.args
        );
      }
      // Repo read tools (H6): source-role repos only, capped.
      if (input.name === "list_repo_files") return await listWorkerRepoFiles(deps, input.projectId);
      if (input.name === "read_repo_file") return await readWorkerRepoFile(deps, input.projectId, input.args);
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
      // Vision agent: `analyze_image` is built on demand (never a per-turn cost)
      // from the project's configured vision model; unconfigured → the tool is
      // absent and the call falls through to the unknown-tool error.
      if (input.name === "analyze_image") {
        const loadImageBase64 = (key: string): Promise<string | null> =>
          runData(Effect.flatMap(Storage, (s) => s.get(key))).then((bytes) => bytesToBase64(bytes)).catch(() => null);
        const resolveMimeType = async (key: string): Promise<string> =>
          (await dbFirst<{ mime_type: string }>(
            `SELECT mime_type FROM chat_attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`,
            input.projectId,
            key
          ))?.mime_type ??
          (await dbFirst<{ mime_type: string }>(
            `SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`,
            input.projectId,
            key
          ))?.mime_type ??
          "image/png";
        const visionTool = await resolveWorkerVisionTool(deps, settings, loadImageBase64, resolveMimeType);
        if (visionTool) tools.push(visionTool as unknown as (typeof tools)[number]);
      }
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

// ── Attachment loader (ADR-0003 §C hydration) ──────────────────────────────
// The DO cannot read blob storage; this Worker-native loader answers the
// internal attachment route with provider-visible content — base64 for image
// attachments, extracted text for documents. Ownership is enforced here against
// the project identity (both attachment tables share one blob store).

export interface WorkerAttachmentInput {
  projectId: string;
  storageKey: string;
}

export function buildWorkerAttachmentLoader(
  deps: WorkerReadToolExecutorDeps
): (input: WorkerAttachmentInput) => Promise<AttachmentContent | null> {
  const storageLayer = Layer.provide(
    Storage.Default,
    Layer.mergeAll(deps.base, Layer.succeed(StorageConfig, storageConfigFor(deps.blob)))
  ) as Layer.Layer<Storage>;
  const dbFirst = <T>(sql: string, ...params: unknown[]): Promise<T | null> =>
    Effect.runPromise(queryFirst<T>(deps.driver, sql, ...params)).catch(() => null);
  return async (input) => {
    const row =
      (await dbFirst<{ mime_type: string }>(
        `SELECT mime_type FROM chat_attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`,
        input.projectId,
        input.storageKey
      )) ??
      (await dbFirst<{ mime_type: string }>(
        `SELECT mime_type FROM attachments WHERE project_id = ? AND storage_key = ? LIMIT 1`,
        input.projectId,
        input.storageKey
      ));
    if (!row) return null;
    const bytes = await Effect.runPromise(
      Effect.provide(Effect.flatMap(Storage, (storage) => storage.get(input.storageKey)), storageLayer)
    ).catch(() => null);
    if (!bytes) return null;
    if (isChatImageMime(row.mime_type)) {
      return { mimeType: row.mime_type, base64: bytesToBase64(bytes) };
    }
    const text = await extractDocumentText(bytes, row.mime_type);
    if (text === null || text.trim() === "") return null;
    return { mimeType: row.mime_type, text };
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
