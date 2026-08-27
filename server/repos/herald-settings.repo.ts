import { Effect } from "effect";
import { Sqlite, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { HeraldReasoningEffort, HeraldSettingsInput, HeraldSettingsMasked } from "../../shared/herald";
import { parseWriteTools } from "../herald/write-tools";

export interface HeraldSettingsRow {
  project_id: string;
  search_provider: "exa" | null;
  search_api_key: string | null;
  url_allowlist: string | null;
  engine: "herald" | "blacksmith";
  engine_switcher_enabled: number;
  primary_supports_images: number;
  reasoning_effort: HeraldReasoningEffort | null;
  write_tools: string;
  fallback_model_ids: string;
  provider_id: string | null;
  primary_model_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseFallbackIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch {}
  return [];
}

export class HeraldSettingsRepo extends Effect.Service<HeraldSettingsRepo>()("Lexa/HeraldSettingsRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    const getRow = (projectId: string): Effect.Effect<HeraldSettingsRow, RowNotFound | DbError> =>
      queryFirst<HeraldSettingsRow>(db, `SELECT * FROM herald_settings WHERE project_id = ?`, projectId);

    const getRowOrNull = (projectId: string): Effect.Effect<HeraldSettingsRow | null, DbError> =>
      Effect.map(
        Effect.catchTag(getRow(projectId), "RowNotFound", () => Effect.succeed(null)),
        (r) => r
      );

    const toMasked = (row: HeraldSettingsRow): HeraldSettingsMasked => ({
      projectId: row.project_id,
      searchProvider: row.search_provider,
      hasSearchKey: row.search_api_key !== null && row.search_api_key !== "",
      urlAllowlist: row.url_allowlist,
      engine: row.engine,
      engineSwitcherEnabled: row.engine_switcher_enabled === 1,
      primarySupportsImages: row.primary_supports_images === 1,
      reasoningEffort: row.reasoning_effort,
      writeTools: parseWriteTools(row.write_tools),
      providerId: (row as unknown as { provider_id?: string | null }).provider_id ?? null,
      modelId: (row as unknown as { primary_model_id?: string | null }).primary_model_id ?? null,
      fallbackModelIds: parseFallbackIds(row.fallback_model_ids),
    });

    return {
      getByProject: getRow,

      upsert: (projectId: string, input: HeraldSettingsInput): Effect.Effect<HeraldSettingsRow, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const existing = yield* getRowOrNull(projectId);
          const fallbackIds = input.fallbackModelIds !== undefined ? JSON.stringify(input.fallbackModelIds.slice(0, 3)) : existing?.fallback_model_ids ?? "[]";
          const providerId = input.providerId !== undefined ? (input.providerId ?? null) : (existing as unknown as { provider_id?: string | null } | null)?.provider_id ?? null;
          const primaryModelId = input.modelId !== undefined ? (input.modelId ?? null) : (existing as unknown as { primary_model_id?: string | null } | null)?.primary_model_id ?? null;
          yield* run(
            db,
            `INSERT INTO herald_settings (project_id, search_provider, search_api_key, url_allowlist,
               engine, engine_switcher_enabled, primary_supports_images, reasoning_effort, write_tools, fallback_model_ids, provider_id, primary_model_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               search_provider = excluded.search_provider,
               url_allowlist = excluded.url_allowlist,
               search_api_key = excluded.search_api_key,
               engine = excluded.engine,
               engine_switcher_enabled = excluded.engine_switcher_enabled,
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
            input.engine ?? "herald",
            input.engineSwitcherEnabled === true ? 1 : 0,
            input.primarySupportsImages === true ? 1 : 0,
            input.reasoningEffort ?? null,
            (input.writeTools ?? []).join(","),
            fallbackIds,
            providerId,
            primaryModelId
          );
          return yield* getRow(projectId);
        }),

      maskedView: (projectId: string): Effect.Effect<HeraldSettingsMasked, RowNotFound | DbError> =>
        Effect.map(getRow(projectId), toMasked),
    };
  }),
}) {}
