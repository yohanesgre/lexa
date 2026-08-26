import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { HeraldModelPrice } from "../../shared/herald";

export interface HeraldModelPriceRow {
  model: string;
  prompt_price: number;
  completion_price: number;
  updated_at: string;
}

function toDomain(row: HeraldModelPriceRow): HeraldModelPrice {
  return { model: row.model, promptPrice: row.prompt_price, completionPrice: row.completion_price, updatedAt: row.updated_at };
}

export class HeraldModelPricesRepo extends Effect.Service<HeraldModelPricesRepo>()("Lexa/HeraldModelPricesRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      upsert: (input: { model: string; promptPrice: number; completionPrice: number }): Effect.Effect<HeraldModelPrice, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO herald_model_prices (model, prompt_price, completion_price) VALUES (?, ?, ?)
           ON CONFLICT(model) DO UPDATE SET prompt_price = excluded.prompt_price, completion_price = excluded.completion_price, updated_at = datetime('now')`,
          input.model, input.promptPrice, input.completionPrice
        ).pipe(
          Effect.flatMap(() => queryFirst<HeraldModelPriceRow>(db, `SELECT * FROM herald_model_prices WHERE model = ?`, input.model)),
          Effect.map(toDomain)
        ),

      getByModel: (model: string): Effect.Effect<HeraldModelPrice, RowNotFound | DbError> =>
        Effect.map(queryFirst<HeraldModelPriceRow>(db, `SELECT * FROM herald_model_prices WHERE model = ?`, model), toDomain),

      list: (): Effect.Effect<HeraldModelPrice[], DbError> =>
        Effect.map(queryAll<HeraldModelPriceRow>(db, `SELECT * FROM herald_model_prices ORDER BY model ASC`), (rows) => rows.map(toDomain)),
    };
  }),
}) {}
