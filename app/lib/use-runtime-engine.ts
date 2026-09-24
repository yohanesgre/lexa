import { useCallback, useState, useEffect, useRef } from "react";
import { Effect, Schedule, Duration, Fiber } from "effect";
import type { RuntimeEngine, AssistantSettingsMasked } from "../../shared/assistant";
import { runtimePollingSchedule, ApiError } from "./effect-api";

// Member-facing personal engine overlay (settings-project-assistant.html Engine
// section + runtime-popover.html annotations): merely SHOWS the toggle in the
// Runtime popover header; the choice is a client-side preference persisted per
// project that overrides the DISPLAYED default — it never writes
// assistant_settings.engine (that column stays the admin-written project
// default).

export function runtimeEngineOverlayKey(projectId: string): string {
  return `runtime-engine-overlay:${projectId}`;
}

export function loadEngineOverlay(projectId: string): RuntimeEngine | null {
  try {
    const raw = window.localStorage.getItem(runtimeEngineOverlayKey(projectId));
    return raw === "assistant" || raw === "blacksmith" ? raw : null;
  } catch {
    return null;
  }
}

export function saveEngineOverlay(projectId: string, engine: RuntimeEngine): void {
  try {
    window.localStorage.setItem(runtimeEngineOverlayKey(projectId), engine);
  } catch {
    // storage unavailable — overlay lasts this session only
  }
}

// Resolved once per render: personal overlay wins when present, else the
// project default. Missing settings row behaves as the assistant default.
export function resolveActiveEngine(settings: AssistantSettingsMasked | null | undefined, projectId: string | undefined): RuntimeEngine {
  if (!projectId || !settings) return "assistant";
  if (settings.engineSwitcherEnabled) {
    const overlay = loadEngineOverlay(projectId);
    if (overlay) return overlay;
  }
  return settings.engine;
}

export function useRuntimeEngineOverlay(): [RuntimeEngine | null, (engine: RuntimeEngine) => void] {
  const [overlay, setOverlay] = useState<RuntimeEngine | null>(null);
  const write = useCallback((engine: RuntimeEngine) => {
    setOverlay(engine);
  }, []);
  return [overlay, write];
}

// Exactly two builtin agents exist (migration 0013) — one per engine tier.
// The persona is NEVER picked client-side; it resolves from the active
// engine and the server re-resolves it authoritatively.
export const ENGINE_AGENT_IDS: Record<RuntimeEngine, string> = {
  assistant: "assistant",
  blacksmith: "blacksmith",
};

export const ENGINE_AGENT_NAMES: Record<RuntimeEngine, string> = {
  assistant: "Assistant Agent",
  blacksmith: "Blacksmith Agent",
};

// Vision resolution order (per request): primary_supports_images=1 → inline
// parts; else vision_model configured → internal analyze_image delegation;
// else attachments are rejected up front with VISION_NOT_CONFIGURED.
export function hasVisionCapability(settings: AssistantSettingsMasked | null | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.primarySupportsImages || settings.visionModel);
}

export const RUNTIME_ENGINE_POLL_BASE_MS = 1500;

export function useRuntimeEnginePolling(enabled: boolean, fetcher: () => Promise<AssistantSettingsMasked | null>, onData: (data: AssistantSettingsMasked | null) => void) {
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onDataRef.current = onData;
  });
  useEffect(() => {
    if (!enabled) return;
    const schedule = Schedule.exponential(Duration.millis(RUNTIME_ENGINE_POLL_BASE_MS)).pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(8)));
    void schedule;
    const effect = Effect.repeat(
      Effect.tryPromise({
        try: () => fetcherRef.current().then((d) => { onDataRef.current(d); return d; }),
        catch: (e) => new ApiError({ code: "FETCH_FAILED", message: String(e) }),
      }),
      runtimePollingSchedule(RUNTIME_ENGINE_POLL_BASE_MS) as unknown as Schedule.Schedule<Duration.Duration, unknown>
    );
    const fiber = Effect.runFork(effect.pipe(Effect.catchAll(() => Effect.succeed(null))));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [enabled]);
}
