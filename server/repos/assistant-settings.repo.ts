import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { AssistantReasoningEffort, AssistantSettingsInput, AssistantSettingsMasked } from "../../shared/assistant";
import { parseWriteTools } from "../assistant/write-tools";

export interface AssistantSettingsRow {
  project_id: string;
  search_provider: "exa" | null;
  search_api_key: string | null;
  url_allowlist: string | null;
  primary_supports_images: number;
  reasoning_effort: AssistantReasoningEffort | null;
  write_tools: string;
  fallback_model_ids: string;
  provider_id: string | null;
  primary_model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantBindingOverview {
  projectId: string;
  projectName: string;
  projectSlug: string;
  providerId: string | null;
  providerLabel: string | null;
  modelId: string | null;
  modelLabel: string | null;
  fallbackCount: number;
  writeToolsCount: number;
  memoryCount: number;
  hasSearchKey: boolean;
  reasoningEffort: AssistantReasoningEffort | null;
  updatedAt: string | null;
}

interface AssistantBindingOverviewRow {
  project_id: string;
  project_name: string;
  project_slug: string;
  provider_id: string | null;
  provider_label: string | null;
  model_id: string | null;
  model_label: string | null;
  fallback_count: number;
  write_tools_count: number;
  memory_count: number;
  has_search_key: number;
  reasoning_effort: AssistantReasoningEffort | null;
  updated_at: string | null;
}

function parseFallbackIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch {}
  return [];
}

export class AssistantSettingsRepo extends Effect.Service<AssistantSettingsRepo>()("Lexa/AssistantSettingsRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const getRow = (projectId: string): Effect.Effect<AssistantSettingsRow, RowNotFound | DbError> =>
      queryFirst<AssistantSettingsRow>(db, `SELECT * FROM assistant_settings WHERE project_id = ?`, projectId);

    const getRowOrNull = (projectId: string): Effect.Effect<AssistantSettingsRow | null, DbError> =>
      Effect.map(
        Effect.catchTag(getRow(projectId), "RowNotFound", () => Effect.succeed(null)),
        (r) => r
      );

    const toMasked = (row: AssistantSettingsRow): AssistantSettingsMasked => ({
      projectId: row.project_id,
      searchProvider: row.search_provider,
      hasSearchKey: row.search_api_key !== null && row.search_api_key !== "",
      urlAllowlist: row.url_allowlist,
      primarySupportsImages: row.primary_supports_images === 1,
      reasoningEffort: row.reasoning_effort,
      writeTools: parseWriteTools(row.write_tools),
      providerId: (row as unknown as { provider_id?: string | null }).provider_id ?? null,
      modelId: (row as unknown as { primary_model_id?: string | null }).primary_model_id ?? null,
      fallbackModelIds: parseFallbackIds(row.fallback_model_ids),
    });

    return {
      getByProject: getRow,

      upsert: (projectId: string, input: AssistantSettingsInput): Effect.Effect<AssistantSettingsRow, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const existing = yield* getRowOrNull(projectId);
          const fallbackIds = input.fallbackModelIds !== undefined ? JSON.stringify(input.fallbackModelIds.slice(0, 3)) : existing?.fallback_model_ids ?? "[]";
          const providerId = input.providerId !== undefined ? (input.providerId ?? null) : (existing as unknown as { provider_id?: string | null } | null)?.provider_id ?? null;
          const primaryModelId = input.modelId !== undefined ? (input.modelId ?? null) : (existing as unknown as { primary_model_id?: string | null } | null)?.primary_model_id ?? null;
          yield* run(
            db,
            `INSERT INTO assistant_settings (project_id, search_provider, search_api_key, url_allowlist,
               primary_supports_images, reasoning_effort, write_tools, fallback_model_ids, provider_id, primary_model_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               search_provider = excluded.search_provider,
               url_allowlist = excluded.url_allowlist,
               search_api_key = excluded.search_api_key,
               primary_supports_images = excluded.primary_supports_images,
               reasoning_effort = excluded.reasoning_effort,
               write_tools = excluded.write_tools,
               fallback_model_ids = excluded.fallback_model_ids,
               provider_id = excluded.provider_id,
               primary_model_id = excluded.primary_model_id,
               updated_at = datetime('now')`,
            projectId,
            input.searchProvider ?? null,
            input.searchApiKey ?? existing?.search_api_key ?? null,
            input.urlAllowlist ?? null,
            input.primarySupportsImages === true ? 1 : 0,
            input.reasoningEffort ?? null,
            (input.writeTools ?? []).join(","),
            fallbackIds,
            providerId,
            primaryModelId
          );
          return yield* getRow(projectId);
        }),

      maskedView: (projectId: string): Effect.Effect<AssistantSettingsMasked, RowNotFound | DbError> =>
        Effect.map(getRow(projectId), toMasked),

      // One row per project for the admin bindings overview. LEFT JOINs keep
      // unconfigured projects visible (provider/model null); labels are
      // resolved server-side in a single query (no N+1).
      listBindingsOverview: (): Effect.Effect<AssistantBindingOverview[], DbError> =>
        Effect.map(
          queryAll<AssistantBindingOverviewRow>(
            db,
            `SELECT p.id AS project_id,
                    p.name AS project_name,
                    p.slug AS project_slug,
                    s.provider_id AS provider_id,
                    pr.label AS provider_label,
                    s.primary_model_id AS model_id,
                    m.model_id AS model_label,
                    CASE WHEN s.fallback_model_ids IS NULL THEN 0 ELSE json_array_length(s.fallback_model_ids) END AS fallback_count,
                    CASE WHEN s.write_tools IS NULL OR s.write_tools = '' THEN 0
                         ELSE LENGTH(s.write_tools) - LENGTH(REPLACE(s.write_tools, ',', '')) + 1 END AS write_tools_count,
                    (SELECT COUNT(*) FROM project_memory pm WHERE pm.project_id = p.id) AS memory_count,
                    CASE WHEN s.search_api_key IS NULL OR s.search_api_key = '' THEN 0 ELSE 1 END AS has_search_key,
                    s.reasoning_effort AS reasoning_effort,
                    s.updated_at AS updated_at
             FROM projects p
             LEFT JOIN assistant_settings s ON s.project_id = p.id
             LEFT JOIN assistant_providers pr ON pr.id = s.provider_id
             LEFT JOIN assistant_models m ON m.id = s.primary_model_id
             ORDER BY p.name COLLATE NOCASE ASC, p.id ASC`
          ),
          (rows) =>
            rows.map((r) => ({
              projectId: r.project_id,
              projectName: r.project_name,
              projectSlug: r.project_slug,
              providerId: r.provider_id,
              providerLabel: r.provider_label,
              modelId: r.model_id,
              modelLabel: r.model_label,
              fallbackCount: r.fallback_count,
              writeToolsCount: r.write_tools_count,
              memoryCount: r.memory_count,
              hasSearchKey: r.has_search_key === 1,
              reasoningEffort: r.reasoning_effort,
              updatedAt: r.updated_at,
            }))
        ),
    };
  }),
}) {}
