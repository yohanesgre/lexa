import { useCallback, useState, useEffect, useRef } from "react";
import { Effect, Schedule, Duration, Fiber } from "effect";
import type { HearthEngine, HeraldSettingsMasked } from "../../shared/herald";
import { hearthPollingSchedule, ApiError } from "./effect-api";

// Member-facing personal engine overlay (settings-project-herald.html Engine
// section + hearth-popover.html annotations): merely SHOWS the toggle in the
// Hearth popover header; the choice is a client-side preference persisted per
// project that overrides the DISPLAYED default — it never writes
// herald_settings.engine (that column stays the admin-written project
// default).

export function hearthEngineOverlayKey(projectId: string): string {
  return `hearth-engine-overlay:${projectId}`;
}

export function loadEngineOverlay(projectId: string): HearthEngine | null {
  try {
    const raw = window.localStorage.getItem(hearthEngineOverlayKey(projectId));
    return raw === "herald" || raw === "blacksmith" ? raw : null;
  } catch {
    return null;
  }
}

export function saveEngineOverlay(projectId: string, engine: HearthEngine): void {
  try {
    window.localStorage.setItem(hearthEngineOverlayKey(projectId), engine);
  } catch {
    // storage unavailable — overlay lasts this session only
  }
}

// Resolved once per render: personal overlay wins when present, else the
// project default. Missing settings row behaves as the herald default.
export function resolveActiveEngine(settings: HeraldSettingsMasked | null | undefined, projectId: string | undefined): HearthEngine {
  if (!projectId || !settings) return "herald";
  if (settings.engineSwitcherEnabled) {
    const overlay = loadEngineOverlay(projectId);
    if (overlay) return overlay;
  }
  return settings.engine;
}

export function useHearthEngineOverlay(): [HearthEngine | null, (engine: HearthEngine) => void] {
  const [overlay, setOverlay] = useState<HearthEngine | null>(null);
  const write = useCallback((engine: HearthEngine) => {
    setOverlay(engine);
  }, []);
  return [overlay, write];
}

// Exactly two builtin agents exist (migration 0013) — one per engine tier.
// The persona is NEVER picked client-side; it resolves from the active
// engine and the server re-resolves it authoritatively.
export const ENGINE_AGENT_IDS: Record<HearthEngine, string> = {
  herald: "hearth-herald",
  blacksmith: "hearth-blacksmith",
};

export const ENGINE_AGENT_NAMES: Record<HearthEngine, string> = {
  herald: "Herald Agent",
  blacksmith: "Blacksmith Agent",
};

// Vision resolution order (per request): primary_supports_images=1 → inline
// parts; else vision_model configured → internal analyze_image delegation;
// else attachments are rejected up front with VISION_NOT_CONFIGURED.
export function hasVisionCapability(settings: HeraldSettingsMasked | null | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.primarySupportsImages || settings.visionModel);
}

export const HEARTH_ENGINE_POLL_BASE_MS = 1500;

export function useHearthEnginePolling(enabled: boolean, fetcher: () => Promise<HeraldSettingsMasked | null>, onData: (data: HeraldSettingsMasked | null) => void) {
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onDataRef.current = onData;
  });
  useEffect(() => {
    if (!enabled) return;
    const schedule = Schedule.exponential(Duration.millis(HEARTH_ENGINE_POLL_BASE_MS)).pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(8)));
    void schedule;
    const effect = Effect.repeat(
      Effect.tryPromise({
        try: () => fetcherRef.current().then((d) => { onDataRef.current(d); return d; }),
        catch: (e) => new ApiError({ code: "FETCH_FAILED", message: String(e) }),
      }),
      hearthPollingSchedule(HEARTH_ENGINE_POLL_BASE_MS) as unknown as Schedule.Schedule<Duration.Duration, unknown>
    );
    const fiber = Effect.runFork(effect.pipe(Effect.catchAll(() => Effect.succeed(null))));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [enabled]);
}
