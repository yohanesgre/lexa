import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Effect, Schedule, Duration, Fiber } from "effect";
import * as api from "./api";
import type { HearthSession, HearthTask } from "../../shared/types";
import { parseApiDate } from "./date";
import { useToast } from "../components/ui/Toast";
import { hearthPollingSchedule, effectFetch, ApiError } from "./effect-api";
import { Schema } from "effect";

export function formatSessionAge(iso: string, now: Date = new Date()): string {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60000) return "just now";
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
  return `${Math.floor(diffMs / 86400000)}d ago`;
}

export function useHearthSession(documentType: "task" | "wiki", documentId: string, enabled = true) {
  return useQuery({
    queryKey: ["hearth-sessions", documentType, documentId],
    queryFn: () => api.listHearthSessions(documentType, documentId).then((r) => r.data),
    enabled,
  });
}

export function useResetHearthSession() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.resetHearthSession,
    onSuccess: (_res, vars) => {
      qc.setQueryData<HearthSession[]>(["hearth-sessions", vars.documentType, vars.documentId], []);
    },
    onError: (err) => {
      toast.push("error", "Could not reset session", toastMessage(err));
    },
  });
}

export const HEARTH_POLL_BASE_MS = 1500;

export function hearthIsActive(task: HearthTask | null | undefined): boolean {
  return task?.status === "queued" || task?.status === "running";
}

export function hearthPollingEffect<T>(fetchEffect: Effect.Effect<T, ApiError>, shouldContinue: (data: T) => boolean): Effect.Effect<T, ApiError> {
  const schedule = Schedule.exponential(Duration.millis(HEARTH_POLL_BASE_MS)).pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(12)));
  return Effect.repeat(
    fetchEffect.pipe(
      Effect.flatMap((data) => (shouldContinue(data) ? Effect.succeed(data) : Effect.fail(new ApiError({ code: "DONE", message: "idle" }))))
    ),
    schedule as unknown as Schedule.Schedule<Duration.Duration, T>
  ) as unknown as Effect.Effect<T, ApiError>;
}

export function useHearthEffectPolling<T>(enabled: boolean, fetcher: () => Promise<T>, isActive: (data: T | undefined) => boolean, onData: (data: T) => void) {
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onDataRef.current = onData;
    isActiveRef.current = isActive;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const schedule = hearthPollingSchedule(HEARTH_POLL_BASE_MS);
    const loop = Effect.gen(function* () {
      while (!cancelled) {
        const data = yield* Effect.tryPromise({
          try: () => fetcherRef.current(),
          catch: (e) => new ApiError({ code: "FETCH_FAILED", message: String(e) }),
        });
        onDataRef.current(data as T);
        if (!isActiveRef.current(data as T)) break;
        yield* Effect.sleep(Duration.millis(1500));
        const check = yield* Effect.tryPromise({
          try: () => fetcherRef.current().then((d) => { onDataRef.current(d); return d; }),
          catch: (e) => new ApiError({ code: "FETCH_FAILED", message: String(e) }),
        });
        void check;
        if (!isActiveRef.current(check as T)) break;
        void schedule;
      }
    });
    const fiber = Effect.runFork(loop);
    return () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [enabled]);
}

export function useHearthTaskEffectPolling(taskId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["hearth-task", taskId],
    queryFn: () =>
      Effect.runPromise(
        effectFetch<HearthTask>(`/api/hearth/tasks/${taskId}`, undefined, Schema.String as unknown as Schema.Schema<HearthTask, unknown>).pipe(
          Effect.catchAll(() => Effect.tryPromise({ try: () => api.getHearthTask(taskId!), catch: (e) => new ApiError({ code: "FETCH_FAILED", message: String(e) }) }))
        )
      ),
    enabled: enabled && taskId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1500 : false;
    },
  });
}

function toastMessage(err: unknown): string {
  const e = err as { code?: string | undefined; message?: string };
  return e.message || "Something went wrong";
}
