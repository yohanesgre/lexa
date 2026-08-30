import { Data, Effect, Schedule, Duration, Schema, Fiber } from "effect";
import * as Option from "effect/Option";
import { TipTapDocSchema } from "../../shared/schema";

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

export const HEARTH_POLL_BASE_MS = 1500;
export const HEARTH_POLL_MAX_MS = 30000;

export function hearthPollingSchedule(baseMs: number = HEARTH_POLL_BASE_MS): Schedule.Schedule<Duration.Duration, unknown> {
  return Schedule.exponential(Duration.millis(baseMs)).pipe(
    Schedule.jittered,
    Schedule.intersect(Schedule.recurs(12))
  ) as unknown as Schedule.Schedule<Duration.Duration, unknown>;
}

export function hearthPollDelayForAttempt(attempt: number, baseMs: number = HEARTH_POLL_BASE_MS): number {
  const raw = baseMs * Math.pow(2, attempt);
  return Math.min(raw, HEARTH_POLL_MAX_MS);
}

export function withHearthPolling<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  baseMs: number = HEARTH_POLL_BASE_MS
): Effect.Effect<A, E, R> {
  return Effect.repeat(effect, hearthPollingSchedule(baseMs) as unknown as Schedule.Schedule<Duration.Duration, A>) as unknown as Effect.Effect<A, E, R>;
}

export function decodeTipTapDoc(doc: unknown): Effect.Effect<import("../../shared/types").TipTapDoc, ApiError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(TipTapDocSchema)(doc) as import("../../shared/types").TipTapDoc,
    catch: (e) => new ApiError({ code: "DECODE_FAILED", message: e instanceof Error ? e.message : String(e) }),
  });
}

export interface DebouncedEffect<A> {
  trigger: (value: A) => void;
  cancel: () => void;
  destroy: () => void;
  pending: () => boolean;
}

export function createDebouncedEffect<A, E>(
  fn: (value: A) => Effect.Effect<void, E>,
  delayMs: number
): DebouncedEffect<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fiber: Fiber.Fiber<void, E> | null = null;
  let pendingValue: A | null = null;
  let hasPending = false;

  const interruptFiber = () => {
    if (fiber) {
      const toInterrupt = fiber;
      fiber = null;
      Effect.runFork(Fiber.interrupt(toInterrupt));
    }
  };

  const trigger = (value: A): void => {
    pendingValue = value;
    hasPending = true;
    if (timer !== null) clearTimeout(timer);
    interruptFiber();
    timer = setTimeout(() => {
      timer = null;
      const arg = pendingValue as A;
      pendingValue = null;
      hasPending = false;
      fiber = Effect.runFork(fn(arg));
    }, delayMs);
  };

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    hasPending = false;
    pendingValue = null;
    interruptFiber();
  };

  return {
    trigger,
    cancel,
    destroy: cancel,
    pending: () => hasPending || timer !== null,
  };
}

export function createWikiAutosaveEffect(
  saveFn: (doc: import("../../shared/types").TipTapDoc) => Effect.Effect<void, ApiError>,
  delayMs: number = 800
): DebouncedEffect<import("../../shared/types").TipTapDoc> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fiber: Fiber.Fiber<void, ApiError> | null = null;
  let pendingValue: import("../../shared/types").TipTapDoc | null = null;
  let hasPending = false;

  const interruptFiber = () => {
    if (fiber) {
      const toInterrupt = fiber;
      fiber = null;
      Effect.runFork(Fiber.interrupt(toInterrupt));
    }
  };

  const trigger = (doc: import("../../shared/types").TipTapDoc): void => {
    pendingValue = doc;
    hasPending = true;
    if (timer !== null) clearTimeout(timer);
    interruptFiber();
    timer = setTimeout(() => {
      timer = null;
      const arg = pendingValue as import("../../shared/types").TipTapDoc;
      pendingValue = null;
      hasPending = false;
      const effect = Effect.flatMap(decodeTipTapDoc(arg as unknown), (decoded) => saveFn(decoded));
      fiber = Effect.runFork(effect);
    }, delayMs);
  };

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    hasPending = false;
    pendingValue = null;
    interruptFiber();
  };

  return { trigger, cancel, destroy: cancel, pending: () => hasPending || timer !== null };
}

export { Option };
