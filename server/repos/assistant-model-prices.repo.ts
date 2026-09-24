import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { AssistantModelPrice } from "../../shared/assistant";

export interface AssistantModelPriceRow {
  model: string;
  prompt_price: number;
  completion_price: number;
  cached_read_price: number;
  cached_write_price: number;
  updated_at: string;
}

function toDomain(row: AssistantModelPriceRow): AssistantModelPrice {
  return { model: row.model, promptPrice: row.prompt_price, completionPrice: row.completion_price, cachedReadPrice: row.cached_read_price, cachedWritePrice: row.cached_write_price, updatedAt: row.updated_at };
}

export class AssistantModelPricesRepo extends Effect.Service<AssistantModelPricesRepo>()("Lexa/AssistantModelPricesRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      upsert: (input: { model: string; promptPrice: number; completionPrice: number; cachedReadPrice: number; cachedWritePrice: number }): Effect.Effect<AssistantModelPrice, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO assistant_model_prices (model, prompt_price, completion_price, cached_read_price, cached_write_price) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(model) DO UPDATE SET prompt_price = excluded.prompt_price, completion_price = excluded.completion_price, cached_read_price = excluded.cached_read_price, cached_write_price = excluded.cached_write_price, updated_at = datetime('now')`,
          input.model, input.promptPrice, input.completionPrice, input.cachedReadPrice, input.cachedWritePrice
        ).pipe(
          Effect.flatMap(() => queryFirst<AssistantModelPriceRow>(db, `SELECT * FROM assistant_model_prices WHERE model = ?`, input.model)),
          Effect.map(toDomain)
        ),

      getByModel: (model: string): Effect.Effect<AssistantModelPrice, RowNotFound | DbError> =>
        Effect.map(queryFirst<AssistantModelPriceRow>(db, `SELECT * FROM assistant_model_prices WHERE model = ?`, model), toDomain),

      list: (): Effect.Effect<AssistantModelPrice[], DbError> =>
        Effect.map(queryAll<AssistantModelPriceRow>(db, `SELECT * FROM assistant_model_prices ORDER BY model ASC`), (rows) => rows.map(toDomain)),
    };
  }),
}) {}
