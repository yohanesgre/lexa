import { useEffect, useState } from "react";
import { useHeraldProviders, useHeraldProjectSettings, useSaveHeraldProjectSettings } from "../../lib/queries/herald-admin";
import { useHeraldSettings } from "../../lib/queries";
import type { HeraldProviderModel } from "../../../shared/herald";
import type { Project } from "../../../shared/types";

function enabledModelsOf(provider: { models?: HeraldProviderModel[] } | undefined): HeraldProviderModel[] {
  if (!provider?.models) return [];
  return provider.models.filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
}

export function HeraldProjectProviderSection({ project }: { project: Project }) {
  const { data: providers = [], isLoading: providersLoading } = useHeraldProviders();
  const { data: legacySettings } = useHeraldSettings(project.id);
  const { data: projectSettings, isLoading: settingsLoading } = useHeraldProjectSettings(project.id);
  const save = useSaveHeraldProjectSettings(project.id);

  const settings = (projectSettings as unknown as { providerId?: string | null; modelId?: string | null; fallbackModelIds?: string[]; searchProvider?: string | null; urlAllowlist?: string | null; hasSearchKey?: boolean; reasoningEffort?: string | null; engine?: string } | null) ?? null;

  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [testState, setTestState] = useState<"idle" | "pending" | "ok" | "fail">("idle");
  const [testLatency, setTestLatency] = useState<number>(0);
  const [testCode, setTestCode] = useState<string>("");

  useEffect(() => {
    if (!hydrated && settings !== undefined) {
      if (settings && (settings.providerId !== undefined || settings.modelId !== undefined)) {
        setProviderId(settings.providerId ?? "");
        setModelId(settings.modelId ?? "");
        setFallbacks(settings.fallbackModelIds ?? []);
        setHydrated(true);
      } else if (!settingsLoading && !providersLoading && legacySettings === null && settings === null) {
        setHydrated(true);
      } else if (settings === null && legacySettings === null && !settingsLoading) {
        setHydrated(true);
      }
    }
  }, [settings, legacySettings, hydrated, settingsLoading, providersLoading]);

  useEffect(() => {
    if (hydrated && settings && settings.providerId) {
      if (providerId !== settings.providerId) {
        // keep local state in sync after save
      }
    }
  }, [settings?.providerId]);

  const selectedProvider = providers.find((p) => p.id === providerId);
  const enabledModels = enabledModelsOf(selectedProvider);
  const allEnabledAcrossProviders = providers.flatMap((p) => (p.models ?? []).filter((m) => m.enabled).map((m) => ({ ...m, providerLabel: p.label, providerId: p.id, baseUrl: (p.baseUrl ?? (p as unknown as { base_url?: string }).base_url) ?? "" })));

  const primaryKey = providerId && modelId ? `${providerId}:${modelId}` : null;
  const fallbackKeySet = new Set(fallbacks);
  const fallbackOptions = allEnabledAcrossProviders.filter((m) => {
    const key = `${m.providerId}:${m.modelId}`;
    if (primaryKey && key === primaryKey) return false;
    if (fallbackKeySet.has(key)) return false;
    if (fallbackKeySet.has(m.modelId)) return false;
    return true;
  });
  const fallbackRows = fallbacks
    .map((fid) => {
      if (fid.includes(":")) {
        const [fidProvider, ...rest] = fid.split(":");
        const fidModel = rest.join(":");
        return allEnabledAcrossProviders.find((m) => m.providerId === fidProvider && m.modelId === fidModel);
      }
      return allEnabledAcrossProviders.find((m) => m.modelId === fid);
    })
    .filter(Boolean) as Array<HeraldProviderModel & { providerLabel: string; providerId: string }>;

  const [addFallbackId, setAddFallbackId] = useState<string>("");

  const moveFallback = (idx: number, dir: -1 | 1) => {
    const next = [...fallbacks];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    const tmp = next[idx];
    next[idx] = next[target];
    next[target] = tmp;
    setFallbacks(next);
  };

  const removeFallback = (idx: number) => {
    setFallbacks((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddFallback = () => {
    if (!addFallbackId) return;
    if (fallbacks.includes(addFallbackId)) return;
    const primKey = providerId && modelId ? `${providerId}:${modelId}` : null;
    if (primKey && addFallbackId === primKey) return;
    if (addFallbackId === modelId) return;
    setFallbacks((prev) => [...prev, addFallbackId]);
    setAddFallbackId("");
  };

  const handleSave = () => {
    save.mutate({ providerId: providerId || null, modelId: modelId || null, fallbackModelIds: fallbacks });
  };

  const handleTest = async () => {
    setTestState("pending");
    try {
      const res = await fetch(`/api/herald/settings/${project.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: providerId || null, modelId: modelId || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (body as { error?: { code?: string } }).error?.code ?? "PROVIDER_UNREACHABLE";
        setTestCode(code);
        setTestState("fail");
        return;
      }
      setTestLatency((body as { latencyMs?: number }).latencyMs ?? 0);
      setTestState("ok");
    } catch {
      setTestCode("PROVIDER_UNREACHABLE");
      setTestState("fail");
    }
  };

  if (providersLoading || settingsLoading) {
    return (
      <section className="mb-8 mt-4">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Herald provider</h2>
        <div className="card-panel card-panel--elevated skeleton" style={{ height: 120 }} />
      </section>
    );
  }

  const hasProviders = providers.length > 0;
  const notConfigured = !settings || !settings.providerId;

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
          <div className="card-panel mt-0" style={{ background: "var(--lx-bg-warning-subtle)", borderColor: "rgba(240,192,64,0.25)", marginBottom: 16 }}>
            <div className="flex items-center gap-2">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-warning)" strokeWidth={1.5}><circle cx={12} cy={12} r={10} /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
              <span className="text-sm font-medium" style={{ color: "var(--lx-text-warning)" }}>PROVIDER_NOT_CONFIGURED</span>
            </div>
            <p className="text-xs text-lx-text-secondary mt-1">No provider configured for this project. Save a provider + model to enable Herald. Until then, Generate returns 409 PROVIDER_NOT_CONFIGURED.</p>
          </div>
        )}

        <div className="field">
          <label className="field-label">Primary provider <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>from registry</span></label>
          <select
            className="prop-input w-full"
            style={{ maxWidth: 480 }}
            value={providerId}
            onChange={(e) => {
              const pid = e.target.value;
              setProviderId(pid);
              const prov = providers.find((p) => p.id === pid);
              const enabled = enabledModelsOf(prov);
              let nextModelId = modelId;
              if (enabled.length && !enabled.some((m) => m.modelId === modelId)) {
                nextModelId = enabled[0].modelId;
                setModelId(nextModelId);
              } else if (!enabled.length) {
                nextModelId = "";
                setModelId("");
              }
              const nextPrimaryKey = pid && nextModelId ? `${pid}:${nextModelId}` : null;
              setFallbacks((prev) => prev.filter((fid) => {
                if (nextPrimaryKey && fid === nextPrimaryKey) return false;
                if (fid === nextModelId) return false;
                return true;
              }));
            }}
            aria-label="Primary provider"
          >
            <option value="">— Select provider —</option>
            {providers.map((p) => {
              const count = (p.models ?? []).filter((m) => m.enabled).length;
              const bu = (p.baseUrl ?? (p as unknown as { base_url?: string }).base_url) ?? "";
              return <option key={p.id} value={p.id}>{p.label} — {bu} ({count} enabled)</option>;
            })}
            {!hasProviders && <option disabled>— No providers — add one in Workspace settings → Herald Providers —</option>}
          </select>
          <div className="field-hint">Registry-owned providers only. Base URL + key live in Workspace settings; this project just picks one.</div>
        </div>

        <div className="field">
          <label className="field-label">Model</label>
          <div style={{ position: "relative", maxWidth: 480 }}>
            <select
              className="prop-input w-full font-mono"
              value={modelId}
              onChange={(e) => {
                const next = e.target.value;
                setModelId(next);
                const nextPrimaryKey = providerId && next ? `${providerId}:${next}` : null;
                setFallbacks((prev) => prev.filter((fid) => {
                  if (nextPrimaryKey && fid === nextPrimaryKey) return false;
                  if (fid === next) return false;
                  return true;
                }));
              }}
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
          <label className="field-label">Fallback models <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>ordered · cross-kind allowed · drag or ↑/↓</span></label>
          <div className="card-panel" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, maxWidth: 480, background: "var(--lx-surface-input)" }}>
            {fallbackRows.map((row, idx) => (
              <div key={`${row.providerId}:${row.modelId}`} className="card-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px" }}>
                <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ color: "var(--lx-text-muted)", cursor: "grab", flexShrink: 0 }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
                <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, flexShrink: 0 }}>{idx + 1}</span>
                <span className="font-mono text-xs text-lx-text-primary" style={{ flex: 1 }}>{row.modelId}</span>
                <span style={{ background: row.kind === "anthropic_compatible" ? "var(--lx-bg-success-subtle)" : "var(--lx-bg-accent-subtle)", color: row.kind === "anthropic_compatible" ? "var(--lx-text-success)" : "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, fontSize: 11 }}>{row.kind}</span>
                <span className="font-mono text-xs text-lx-text-muted" style={{ whiteSpace: "nowrap" }}>via {row.providerLabel}</span>
                <div className="flex items-center" style={{ gap: 2, flexShrink: 0 }}>
                  <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Move up" onClick={() => moveFallback(idx, -1)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 19V5M5 12l7-7 7 7" /></svg></button>
                  <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Move down" onClick={() => moveFallback(idx, 1)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 5v14M19 12l-7 7-7-7" /></svg></button>
                  <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Remove" onClick={() => removeFallback(idx)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M18 6L6 18M6 6l12 12" /></svg></button>
                </div>
              </div>
            ))}
            {fallbacks.length === 0 && <div className="text-xs text-lx-text-muted" style={{ padding: "4px 8px" }}>No fallbacks — primary only.</div>}
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              <select className="prop-input flex-1 font-mono" style={{ height: 28, fontSize: 12 }} value={addFallbackId} onChange={(e) => setAddFallbackId(e.target.value)}>
                <option value="">Add fallback…</option>
                {fallbackOptions.map((m) => (
                  <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>{m.modelId} — {m.kind} ({m.providerLabel})</option>
                ))}
                {modelId && <option disabled>{modelId} (primary — already selected)</option>}
              </select>
              <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={handleAddFallback}>Add</button>
            </div>
          </div>
          <div className="field-hint">Ordered fallback chain — tried in priority order after the primary model fails (auth/rate-limit/unreachable). Cross-kind allowed: OpenAI and Anthropic models can interleave.</div>
        </div>

        <div className="field">
          <label className="field-label">Test connection</label>
          <div className="flex items-start gap-3" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn btn-ghost" style={{ alignSelf: "center", height: 28, padding: "0 10px", fontSize: 12 }} onClick={handleTest} disabled={!providerId || !modelId || testState === "pending"}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>
              Test connection
            </button>
            {testState === "pending" && (
              <div className="card-row card-row--neutral" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  <span className="text-xs font-medium text-lx-text-primary">Testing…</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">Minimal completion ping (+ Exa ping when set)</div>
              </div>
            )}
            {testState === "ok" && (
              <div className="card-row card-row--success" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-success)" strokeWidth={2.5}><path d="M20 6L9 17l-5-5" /></svg>
                  <span className="text-xs font-medium text-lx-text-primary">OK · {testLatency} ms</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">Provider reachable · key valid</div>
              </div>
            )}
            {testState === "fail" && (
              <div className="card-row card-row--danger" style={{ width: 220 }}>
                <div className="flex items-center gap-2">
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-danger)" strokeWidth={2}><circle cx={12} cy={12} r={10} /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>
                  <span className="text-xs font-medium text-lx-text-danger font-mono">{testCode}</span>
                </div>
                <div className="text-xs text-lx-text-secondary mt-1">Upstream rejected the key (401). Other outcome: PROVIDER_UNREACHABLE.</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-5" style={{ borderTop: "1px solid var(--lx-border-subtle)", paddingTop: 16 }}>
          <span className="field-hint">Omitted optional fields keep stored values. Uses setQueryData from the mutation response, never invalidate.</span>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={save.isPending || !providerId || !modelId}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
