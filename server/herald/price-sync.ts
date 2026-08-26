import { Effect } from "effect";
import { Sqlite } from "../db/database";
import { HeraldModelPricesRepo } from "../repos/herald-model-prices.repo";
import { ProviderUnreachable } from "../api/errors";

const PRICE_RE = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

function isValidPriceString(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  if (!PRICE_RE.test(t)) return false;
  const n = Number(t);
  return Number.isFinite(n);
}

export const syncModelPrices = (): Effect.Effect<number, ProviderUnreachable, Sqlite | HeraldModelPricesRepo> =>
  Effect.gen(function* () {
    const repo = yield* HeraldModelPricesRepo;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15_000);
    if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
    try {
      const res = yield* Effect.tryPromise({
        try: () => fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal }),
        catch: (e) => e as Error,
      }).pipe(
        Effect.mapError((e) => new ProviderUnreachable({ message: String((e as Error).message ?? e) }))
      );
      if (!res) return yield* Effect.fail(new ProviderUnreachable({ message: "no response" }));
      if (!res.ok) {
        return yield* Effect.fail(new ProviderUnreachable({ message: `models endpoint returned ${res.status}` }));
      }
      const json = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> }>,
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed({ data: [] as Array<never> })))) as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
      let count = 0;
      for (const m of json.data ?? []) {
        const rawP = m.pricing?.prompt?.trim() ?? "";
        const rawC = m.pricing?.completion?.trim() ?? "";
        if (!isValidPriceString(rawP) || !isValidPriceString(rawC)) continue;
        const p = parseFloat(rawP);
        const c = parseFloat(rawC);
        if (!Number.isFinite(p) || !Number.isFinite(c)) continue;
        if (Number.isNaN(p) || Number.isNaN(c)) continue;
        if (p === 0 && c === 0) continue;
        yield* repo.upsert({ model: m.id, promptPrice: p, completionPrice: c }).pipe(
          Effect.catchAll((e) => {
            console.warn("[price-sync] upsert failed", m.id, e);
            return Effect.succeed(null as never);
          })
        );
        count += 1;
      }
      console.log(`[price-sync] synced ${count} model prices`);
      return count;
    } finally {
      clearTimeout(t);
    }
  });
