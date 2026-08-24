import { Effect } from "effect";
import { Sqlite, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { InvalidArgs } from "../api/errors";
import type { HeraldReasoningEffort, HeraldSettingsInput, HeraldSettingsMasked } from "../../shared/herald";

export interface HeraldSettingsRow {
  project_id: string;
  kind: HeraldSettingsMasked["kind"];
  base_url: string;
  api_key: string;
  model: string;
  search_provider: "exa" | null;
  search_api_key: string | null;
  url_allowlist: string | null;
  engine: "herald" | "blacksmith";
  engine_switcher_enabled: number;
  primary_supports_images: number;
  vision_model: string | null;
  reasoning_effort: HeraldReasoningEffort | null;
  created_at: string;
  updated_at: string;
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
      kind: row.kind,
      baseUrl: row.base_url,
      model: row.model,
      hasKey: true,
      keyMask: `sk-…${row.api_key.slice(-4)}`,
      searchProvider: row.search_provider,
      hasSearchKey: row.search_api_key !== null && row.search_api_key !== "",
      urlAllowlist: row.url_allowlist,
      engine: row.engine,
      engineSwitcherEnabled: row.engine_switcher_enabled === 1,
      primarySupportsImages: row.primary_supports_images === 1,
      visionModel: row.vision_model,
      reasoningEffort: row.reasoning_effort,
    });

    return {
      getByProject: getRow,

      // Omitted keys (apiKey/searchApiKey undefined) keep the
      // stored value; on a fresh insert an omitted api_key would violate NOT
      // NULL (a project cannot be configured keyless) — rejected up front as
      // INVALID_ARGS. Vision shares the primary provider credentials; only
      // vision_model is stored separately.
      upsert: (projectId: string, input: HeraldSettingsInput): Effect.Effect<HeraldSettingsRow, InvalidArgs | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const existing = yield* getRowOrNull(projectId);
          if (existing === null && (input.apiKey === undefined || input.apiKey === "")) {
            return yield* new InvalidArgs({ reason: "apiKey required on first save" });
          }
          yield* run(
            db,
            `INSERT INTO herald_settings (project_id, kind, base_url, api_key, model, search_provider, search_api_key, url_allowlist,
               engine, engine_switcher_enabled, primary_supports_images, vision_model, reasoning_effort)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               kind = excluded.kind,
               base_url = excluded.base_url,
               model = excluded.model,
               search_provider = excluded.search_provider,
               url_allowlist = excluded.url_allowlist,
               api_key = excluded.api_key,
               search_api_key = excluded.search_api_key,
               engine = excluded.engine,
               engine_switcher_enabled = excluded.engine_switcher_enabled,
               primary_supports_images = excluded.primary_supports_images,
               vision_model = excluded.vision_model,
               reasoning_effort = excluded.reasoning_effort,
               updated_at = datetime('now')`,
            projectId,
            input.kind,
            input.baseUrl,
            input.apiKey ?? existing?.api_key ?? null,
            input.model,
            input.searchProvider ?? null,
            input.searchApiKey ?? existing?.search_api_key ?? null,
            input.urlAllowlist ?? null,
            input.engine ?? "herald",
            input.engineSwitcherEnabled === true ? 1 : 0,
            input.primarySupportsImages === true ? 1 : 0,
            input.visionModel ?? null,
            input.reasoningEffort ?? null
          );
          return yield* getRow(projectId);
        }),

      maskedView: (projectId: string): Effect.Effect<HeraldSettingsMasked, RowNotFound | DbError> =>
        Effect.map(getRow(projectId), toMasked),
    };
  }),
}) {}
