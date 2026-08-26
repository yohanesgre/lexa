import { useState } from "react";
import { Trash2, Settings, RefreshCw } from "lucide-react";
import { useHeraldProviders, useCreateProvider, useUpdateProvider, useDeleteProvider, useTestProvider, useFetchModels, useUpdateProviderModel } from "../../lib/queries/herald-admin";
import type { HeraldProvider, HeraldProviderModel } from "../../../shared/herald";

function normalizeBaseUrl(u: string): string {
  return u.trim();
}

export function HeraldProvidersSection() {
  const { data: providers = [], isLoading } = useHeraldProviders();
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const del = useDeleteProvider();
  const test = useTestProvider();
  const fetchModels = useFetchModels();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { state: "pending" | "ok" | "fail"; latencyMs?: number; code?: string; message?: string }>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const editing = editingId ? providers.find((p) => p.id === editingId) : null;

  const resetForm = () => {
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setEditingId(null);
  };

  const startEdit = (p: HeraldProvider) => {
    setEditingId(p.id);
    setLabel(p.label);
    setBaseUrl((p.baseUrl ?? (p as unknown as { base_url?: string }).base_url) ?? "");
    setApiKey("");
  };

  const handleSave = () => {
    const payload = { label: label.trim(), baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim() };
    if (!payload.label || !payload.baseUrl) return;
    if (editingId) {
      const patch: { label?: string; baseUrl?: string; apiKey?: string } = { label: payload.label, baseUrl: payload.baseUrl };
      if (payload.apiKey) patch.apiKey = payload.apiKey;
      update.mutate({ id: editingId, ...patch } as never, { onSuccess: resetForm });
    } else {
      if (!payload.apiKey) return;
      create.mutate({ label: payload.label, baseUrl: payload.baseUrl, apiKey: payload.apiKey }, { onSuccess: resetForm });
    }
  };

  const handleTest = (id: string) => {
    setTestResults((m) => ({ ...m, [id]: { state: "pending" } }));
    test.mutate(id, {
      onSuccess: (res) => setTestResults((m) => ({ ...m, [id]: { state: "ok", latencyMs: res.latencyMs } })),
      onError: (err) => {
        const e = err as { code?: string; message?: string };
        setTestResults((m) => ({ ...m, [id]: { state: "fail", code: e.code ?? "PROVIDER_UNREACHABLE", message: e.message } }));
      },
    });
  };

  const handleFetch = (id: string) => {
    fetchModels.mutate(id);
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Herald Providers</h2>
          <span className="text-xs text-lx-text-muted">superadmin-gated</span>
        </div>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Central registry of LLM providers Herald can use. Projects pick a primary provider + model from this list; the registry owns base URLs, keys, and the enabled model catalog. Keys are write-only (masked on read, never serialized).
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "28%" }}>Label</th><th style={{ width: "38%" }}>Base URL</th><th style={{ width: "14%" }}>Models</th><th style={{ width: "20%", textAlign: "right" }}>Actions</th></tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const bu = (p.baseUrl ?? (p as unknown as { base_url?: string }).base_url) ?? "";
                const models = p.models ?? [];
                const enabled = models.filter((m) => m.enabled).length;
                const total = models.length;
                const isExpanded = expanded === p.id;
                const testState = testResults[p.id];
                return (
                  <>
                    <tr key={p.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          <button type="button" className="text-sm font-medium text-lx-text-primary" style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setExpanded(isExpanded ? null : p.id)}>
                            {p.label}
                          </button>
                          <span className="font-micro text-2xs" style={{ background: enabled > 0 ? "var(--lx-bg-success-subtle)" : "var(--lx-surface-elevated)", color: enabled > 0 ? "var(--lx-text-success)" : "var(--lx-text-muted)", padding: "2px 6px", borderRadius: 9999, border: enabled > 0 ? "none" : "1px solid var(--lx-border-default)" }}>
                            {enabled > 0 ? "active" : `${enabled} enabled · ${total} total`}
                          </span>
                          {enabled > 0 && <span className="font-micro text-2xs" style={{ display: "none" }} />}
                        </div>
                      </td>
                      <td className="font-mono text-xs text-lx-text-secondary">{bu}</td>
                      <td className="text-xs text-lx-text-secondary">{total === 0 ? "—" : `${enabled} enabled · ${total} total`}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        {testState?.state === "pending" ? (
                          <span className="flex items-center justify-end gap-2" style={{ display: "inline-flex" }}>
                            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                            <span className="text-xs text-lx-text-secondary">Testing…</span>
                          </span>
                        ) : testState?.state === "ok" ? (
                          <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", padding: "2px 6px", borderRadius: 9999 }}>OK · {testState.latencyMs} ms</span>
                        ) : testState?.state === "fail" ? (
                          <span className="font-mono text-xs" style={{ color: "var(--lx-text-danger)" }}>{testState.code}</span>
                        ) : null}
                        <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12, marginLeft: 6 }} onClick={() => handleTest(p.id)} disabled={test.isPending}>
                          Test
                        </button>
                        <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} aria-label="Edit provider" onClick={() => startEdit(p)}>
                          <Settings size={14} strokeWidth={1.5} />
                        </button>
                        <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} aria-label="Delete provider" onClick={() => setDeleteConfirm(p.id)}>
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={4} style={{ padding: 0, border: "none", background: "var(--lx-surface-elevated)" }}>
                          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--lx-border-subtle)" }}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-lx-text-primary">Models — {p.label}</span>
                                <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{enabled} enabled of {total} · drag to reprioritize</span>
                              </div>
                              <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => handleFetch(p.id)} disabled={fetchModels.isPending}>
                                <RefreshCw size={12} strokeWidth={1.5} className={fetchModels.isPending ? "animate-spin" : undefined} />
                                Fetch models
                              </button>
                            </div>
                            <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
                              <table className="settings-table">
                                <thead>
                                  <tr><th style={{ width: 36 }}></th><th>Model ID</th><th style={{ width: 150 }}>Kind</th><th style={{ width: 70 }}>Priority</th><th style={{ width: 80 }}>Enabled</th></tr>
                                </thead>
                                <tbody>
                                  {models.length === 0 ? (
                                    <tr><td colSpan={5} className="text-xs text-lx-text-muted" style={{ textAlign: "center", padding: 16 }}>No models — fetch from provider.</td></tr>
                                  ) : models.map((m) => (
                                    <ModelRow key={m.modelId ?? m.id} providerId={p.id} model={m} />
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
              {providers.length === 0 && (
                <tr><td colSpan={4} className="text-sm text-lx-text-muted" style={{ textAlign: "center", padding: 24 }}>No providers yet — add one below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-panel card-panel--elevated mt-4">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">{editingId ? "Edit provider" : "Add provider"}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label">Label</label>
            <input className="prop-input w-full" placeholder="OpenRouter" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label">Base URL</label>
            <input className="prop-input w-full font-mono" placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        </div>
        <div className="field mt-3" style={{ marginBottom: 0 }}>
          <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
            <label className="field-label" style={{ marginBottom: 0 }}>API key</label>
            {editing?.hasKey && (
              <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
                Saved · <span className="font-mono">{editing.keyMask ?? "sk-…8f3a"}</span>
              </span>
            )}
          </div>
          <input className="prop-input w-full font-mono" type="password" placeholder={editing?.hasKey ? `Type to replace ${editing.keyMask ?? "sk-…8f3a"}` : "sk-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ maxWidth: 480 }} />
          <div className="field-hint">Empty keeps the stored key. Typing replaces it on Save — write-only, never read back.</div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={create.isPending || update.isPending || !label.trim() || !baseUrl.trim() || (!editingId && !apiKey.trim())}>
            {editingId ? "Save provider" : "Save provider"}
          </button>
          {editingId && <button type="button" className="btn btn-ghost" onClick={resetForm}>Cancel</button>}
        </div>
      </div>

      {providers.length === 0 && (
        <div className="card-panel mt-4" style={{ background: "var(--lx-bg-warning-subtle)", borderColor: "rgba(240,192,64,0.25)" }}>
          <div className="flex items-center gap-2">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-warning)" strokeWidth={1.5}><circle cx={12} cy={12} r={10} /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
            <span className="text-sm font-medium" style={{ color: "var(--lx-text-warning)" }}>No providers yet</span>
          </div>
          <p className="text-xs text-lx-text-secondary mt-1">Add a provider above to enable Herald. Projects cannot select a model until at least one provider has enabled models.</p>
        </div>
      )}

      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <button type="button" className="slideover-overlay" onClick={() => setDeleteConfirm(null)} aria-label="Close" />
          <div className="card-panel" style={{ position: "relative", zIndex: 1, maxWidth: 420 }}>
            <h3 className="font-display text-base font-medium text-lx-text-primary">Delete provider?</h3>
            <p className="text-sm text-lx-text-secondary mt-2">This will permanently delete the provider. Projects referencing it will fail with 409 until reassigned.</p>
            <div className="flex items-center gap-2 mt-4 justify-end">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button type="button" className="btn btn-danger-solid" onClick={() => del.mutate(deleteConfirm, { onSuccess: () => setDeleteConfirm(null) })}><Trash2 size={14} strokeWidth={1.5} /> Delete</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ModelRow({ providerId, model }: { providerId: string; model: HeraldProviderModel }) {
  const update = useUpdateProviderModel(providerId);
  const mid = model.modelId ?? (model as unknown as { model_id?: string }).model_id ?? model.id;
  return (
    <tr>
      <td style={{ textAlign: "center" }}>
        <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ color: "var(--lx-text-muted)", cursor: "grab" }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
      </td>
      <td className="font-mono text-xs" style={{ color: model.enabled ? "var(--lx-text-primary)" : "var(--lx-text-secondary)" }}>{mid}</td>
      <td><span style={{ background: model.kind === "anthropic_compatible" ? "var(--lx-bg-success-subtle)" : "var(--lx-bg-accent-subtle)", color: model.kind === "anthropic_compatible" ? "var(--lx-text-success)" : "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, fontSize: 11 }}>{model.kind}</span></td>
      <td className="font-mono text-xs text-lx-text-secondary">{model.priority}</td>
      <td>
        <button type="button" className={`toggle-switch${model.enabled ? " is-on" : ""}`} aria-label={model.enabled ? "Enabled" : "Disabled"} onClick={() => update.mutate({ modelId: mid, enabled: !model.enabled })} />
      </td>
    </tr>
  );
}
