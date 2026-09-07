import { useEffect, useRef, useState } from "react";
import { defaultsStep, hydrateStep } from "../components/settings/herald-project-logic";
import type { ProviderLike } from "../components/settings/herald-project-logic";

// Project Settings → Herald provider model state: hydrate once from fetched
// settings, then settle defaults — one effect per step, no chained
// state→effect rounds (defaults need the hydrated values, so they settle on
// the pass after hydration lands).
export function useHeraldProjectModels(args: {
  settings: { providerId?: string | null | undefined; modelId?: string | null | undefined; fallbackModelIds?: string[] } | null | undefined;
  legacySettings: unknown;
  settingsLoading: boolean;
  providersLoading: boolean;
  providers: ProviderLike[];
}) {
  const { settings, legacySettings, settingsLoading, providersLoading, providers } = args;
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || settings === undefined) return;
    const step = hydrateStep({ settings, legacySettings, settingsLoading });
    if (step.patch) {
      setProviderId(step.patch.providerId);
      setModelId(step.patch.modelId);
      setFallbacks(step.patch.fallbacks);
    }
    if (step.settled) hydratedRef.current = true;
  }, [settings, legacySettings, settingsLoading]);

  useEffect(() => {
    if (!hydratedRef.current || providersLoading || settingsLoading) return;
    const step = defaultsStep(providers, providerId, modelId, fallbacks.length);
    if (step.primary) {
      setProviderId(step.primary.providerId);
      setModelId(step.primary.modelId);
      setFallbacks(step.primary.fallbacks);
    } else if (step.fallbacks) {
      setFallbacks(step.fallbacks);
    }
  }, [settings, legacySettings, settingsLoading, providersLoading, providers, providerId, modelId, fallbacks.length]);

  return { providerId, setProviderId, modelId, setModelId, fallbacks, setFallbacks };
}
