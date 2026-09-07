import { useState } from "react";
import { useHeraldProviders, useHeraldProjectSettings, useSaveHeraldProjectSettings } from "../../lib/queries/herald-admin";
import { useHeraldSettings } from "../../lib/queries";
import { useHeraldProjectModels } from "../../lib/use-herald-project-models";
import { WarningNotice } from "../ui/NoticeWarning";
import {
  canAddFallback,
  enabledModelsAcross,
  enabledModelsOf,
  fallbackOptionsFor,
  fallbackRowsFor,
  hasPrimary,
  moveFallback,
  onModelChange,
  onProviderChange,
  primaryKeyOf,
  providerOptionLabel,
  savePayload,
} from "./herald-project-logic";
import { HeraldFallbackList } from "./HeraldFallbackList";
import { HeraldTestSection } from "./HeraldTestSection";
import type { Project } from "../../../shared/types";

export function HeraldProjectProviderSection({ project }: { project: Project }) {
  const { data: providers = [], isLoading: providersLoading } = useHeraldProviders();
  const { data: legacySettings } = useHeraldSettings(project.id);
  const { data: projectSettings, isLoading: settingsLoading } = useHeraldProjectSettings(project.id);
  const save = useSaveHeraldProjectSettings(project.id);

  const settings = (projectSettings as unknown as { providerId?: string | null | undefined; modelId?: string | null | undefined; fallbackModelIds?: string[]; searchProvider?: string | null | undefined; urlAllowlist?: string | null | undefined; hasSearchKey?: boolean | undefined; reasoningEffort?: string | null | undefined; engine?: string } | null) ?? null;

  const modelState = useHeraldProjectModels({ settings, legacySettings, settingsLoading, providersLoading, providers });
  const { providerId, setProviderId, modelId, setModelId, fallbacks, setFallbacks } = modelState;

  const [addFallbackId, setAddFallbackId] = useState<string>("");

  const selectedProvider = providers.find((p) => p.id === providerId);
  const enabledModels = enabledModelsOf(selectedProvider);
  const allEnabled = enabledModelsAcross(providers);
  const primaryKey = primaryKeyOf(providerId, modelId);
  const fallbackRows = fallbackRowsFor(fallbacks, allEnabled);
  const fallbackOptions = fallbackOptionsFor(allEnabled, primaryKey, fallbacks);

  const handleProviderChange = (pid: string) => {
    setProviderId(pid);
    const next = onProviderChange(providers, pid, modelId, fallbacks);
    setModelId(next.modelId);
    setFallbacks(next.fallbacks);
  };

  const handleModelChange = (next: string) => {
    setModelId(next);
    setFallbacks(onModelChange(providerId, next, fallbacks));
  };

  const handleMoveFallback = (idx: number, dir: -1 | 1) => setFallbacks(moveFallback(fallbacks, idx, dir));

  const handleRemoveFallback = (idx: number) => setFallbacks((prev) => prev.filter((_, i) => i !== idx));

  const handleAddFallback = () => {
    if (!canAddFallback(fallbacks, addFallbackId, primaryKey, modelId)) return;
    setFallbacks((prev) => [...prev, addFallbackId]);
    setAddFallbackId("");
  };

  const handleSave = () => {
    save.mutate(savePayload(providerId, modelId, fallbacks));
  };

  if (providersLoading || settingsLoading) {
    return (
      <section className="mb-8 mt-4">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Herald provider</h2>
        <div className="card-panel card-panel--elevated skeleton" style={{ height: 120 }} />
      </section>
    );
  }

  const notConfigured = !settings?.providerId;

  return (
    <section className="mb-8 mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Herald provider</h2>
        <span className="text-xs text-lx-text-muted">GET /api/herald/settings/:projectId</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Herald (the writing assistant in the Hearth popover) runs against a provider from the workspace registry. Base URLs and keys live on the provider registry (Workspace → Herald Providers); this project picks a primary provider + model and an optional ordered fallback chain.
      </p>

      <div className="card-panel card-panel--elevated">
        {notConfigured && (
            <WarningNotice className="mt-0" style={{ marginBottom: 16 }} title="PROVIDER_NOT_CONFIGURED">
              No provider configured for this project. Save a provider + model to enable Herald. Until then, Generate returns 409 PROVIDER_NOT_CONFIGURED.
            </WarningNotice>
        )}

        <div className="field">
          <label className="field-label" htmlFor="herald-primary-provider">Primary provider <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>from registry</span></label>
          <select
            id="herald-primary-provider"
            className="prop-input w-full"
            style={{ maxWidth: 480 }}
            value={providerId}
            onChange={(e) => handleProviderChange(e.target.value)}
            aria-label="Primary provider"
          >
            <option value="">— Select provider —</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{providerOptionLabel(p)}</option>)}
            {providers.length === 0 && <option disabled>— No providers — add one in Workspace settings → Herald Providers —</option>}
          </select>
          <div className="field-hint">Registry-owned providers only. Base URL + key live in Workspace settings; this project just picks one.</div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="herald-project-model">Model</label>
          <div style={{ position: "relative", maxWidth: 480 }}>
            <select
              id="herald-project-model"
              className="prop-input w-full font-mono"
              value={modelId}
              onChange={(e) => handleModelChange(e.target.value)}
              aria-label="Model"
              disabled={!selectedProvider}
            >
              <option value="">{selectedProvider ? "— Select model —" : "Select a provider first"}</option>
              {enabledModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>{m.modelId} — {m.kind} · pri {m.priority}</option>
              ))}
            </select>
          </div>
          <div className="field-hint">Filtered to the primary provider's enabled models — priority order from the registry, but you can still pick any enabled id. Registry manages the catalog (Fetch models lives in Workspace → Herald Providers, not here).</div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="herald-add-fallback">Fallback models <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>ordered · cross-kind allowed · drag or ↑/↓</span></label>
          <HeraldFallbackList
            fallbacks={fallbacks}
            fallbackRows={fallbackRows}
            fallbackOptions={fallbackOptions}
            addFallbackId={addFallbackId}
            onAddFallbackIdChange={setAddFallbackId}
            onAdd={handleAddFallback}
            onMove={handleMoveFallback}
            onRemove={handleRemoveFallback}
            modelId={modelId}
          />
          <div className="field-hint">Ordered fallback chain — tried in priority order after the primary model fails (auth/rate-limit/unreachable). Cross-kind allowed: OpenAI and Anthropic models can interleave.</div>
        </div>

        <div className="field">
          <span className="field-label">Test connection</span>
          <HeraldTestSection
            projectId={project.id}
            providerId={providerId}
            modelId={modelId}
            fallbacks={fallbacks}
            fallbackRows={fallbackRows}
            providerLabel={selectedProvider?.label ?? providerId ?? "—"}
          />
        </div>

        <div className="flex items-center justify-between mt-5" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <span className="field-hint">Omitted optional fields keep stored values. Uses setQueryData from the mutation response, never invalidate.</span>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={save.isPending || !hasPrimary(providerId, modelId)}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
