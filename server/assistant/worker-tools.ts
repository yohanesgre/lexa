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
import { Db, queryAll, queryFirst } from "../db/db";
import type { RuntimeEnv } from "../env";
import { RuntimeEnvTag } from "../runtime-env";
import { TaskRepo } from "../repos/task.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { Storage, StorageConfig } from "../storage/storage";
import type { R2Bucket as NarrowR2Bucket, StorageConfigShape } from "../storage/config";
import { AssistantJevService } from "../services/assistant-jev.service";
import { TaskService } from "../services/task.service";
import { CommentService } from "../services/comment.service";
import { WikiService } from "../services/wiki.service";
import { MilestoneService } from "../services/milestone.service";
import { SwimlaneService } from "../services/swimlane.service";
import { AuthorizationService } from "../services/authorization.service";
import { errorCodeMap } from "../api/errors";
import { applyAssistantWrite, type AssistantWriteApplyCtx } from "./write-execution";
import type { AssistantWriteToolName } from "./write-tool-names";
import { BOUND_SKILLS_SQL, matchBoundSkillByName } from "../services/assistant-helpers";
import { docToMarkdown } from "../../shared/markdown";
import { parseWriteTools } from "./write-tools";
import { buildAssistantTools, type AssistantToolDeps, type BoundSkill } from "./tools";
import { resolveVisionMode } from "./vision";
import type { JevRuntimeConfig } from "./jev";
import type { ApprovalPartial } from "../../shared/assistant";
import type { ReadToolResponse, WriteExecuteResponse } from "./tools-ai";

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

export interface WorkerTurnContext extends WorkerTurnSettings {
  /** Read-tool names the DO may offer this turn (optional tools gated). */
  readTools: string[];
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
    ...settings,
    readTools: [...available],
    jevConfigured: jevConfig !== null,
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
