import { Data, Effect, Schedule, Duration, Schema } from "effect";
import * as Option from "effect/Option";

export class ApiError extends Data.TaggedError("ApiError")<{ code: string; message: string }> {}

export function effectFetch<T>(
  url: string,
  init: RequestInit | undefined,
  schema: Schema.Schema<T, unknown>
): Effect.Effect<T, ApiError> {
  return Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (e) => new ApiError({ code: "FETCH_FAILED", message: e instanceof Error ? e.message : String(e) }),
  }).pipe(
    Effect.flatMap((res) => {
      if (!res.ok) {
        return Effect.tryPromise({
          try: () => res.json().catch(() => ({})) as Promise<{ error?: { code?: string; message?: string } }>,
          catch: () => ({}) as { error?: { code?: string; message?: string } },
        }).pipe(
          Effect.flatMap((body) =>
            Effect.fail(new ApiError({ code: body.error?.code ?? `HTTP_${res.status}`, message: body.error?.message ?? `Request failed (${res.status})` }))
          )
        ) as unknown as Effect.Effect<T, ApiError>;
      }
      if (res.status === 204) return Effect.succeed(undefined as unknown as T);
      return Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (e) => new ApiError({ code: "DECODE_FAILED", message: String(e) }),
      }).pipe(
        Effect.flatMap((raw) => {
          if (raw instanceof ApiError) return Effect.fail(raw as ApiError) as unknown as Effect.Effect<T, ApiError>;
          return Effect.try({
            try: () => Schema.decodeUnknownSync(schema)(raw as unknown) as T,
            catch: (e) => new ApiError({ code: "DECODE_FAILED", message: e instanceof Error ? e.message : String(e) }),
          });
        })
      );
    })
  ) as unknown as Effect.Effect<T, ApiError>;
}

export function withTimeout<A, E, R>(effect: Effect.Effect<A, E, R>, ms: number): Effect.Effect<Option.Option<A>, E, R> {
  return Effect.timeout(effect, Duration.millis(ms)) as unknown as Effect.Effect<Option.Option<A>, E, R>;
}

export function withRetry<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  schedule: Schedule.Schedule<unknown, E, R> = Schedule.recurs(1) as unknown as Schedule.Schedule<unknown, E, R>
): Effect.Effect<A, E, R> {
  return Effect.retry(effect, schedule as unknown as Schedule.Schedule<never, E>) as unknown as Effect.Effect<A, E, R>;
}

export { Option };
