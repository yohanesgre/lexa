import { useState, Fragment } from "react";
import { createPortal } from "react-dom";
import { Trash2, Settings, RefreshCw, ChevronDown } from "lucide-react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useHeraldProviders, useCreateProvider, useUpdateProvider, useDeleteProvider, useTestProvider, useFetchModels, useUpdateProviderModel, useReorderProviderModels } from "../../lib/queries/herald-admin";
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
  const [testResults, setTestResults] = useState<Record<string, { state: "pending" | "ok" | "fail"; latencyMs?: number | undefined; code?: string | undefined; message?: string | undefined }>>({});
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
      const patch: { label?: string | undefined; baseUrl?: string | undefined; apiKey?: string } = { label: payload.label, baseUrl: payload.baseUrl };
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
        const e = err as { code?: string | undefined; message?: string | undefined };
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
                  <Fragment key={p.id}>
                    <tr style={{ cursor: "pointer" }} className="is-expandable" onClick={() => setExpanded(isExpanded ? null : p.id)}>
                      <td style={{ maxWidth: 0 }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <button type="button" title={p.label} className="flex items-center gap-1.5 text-sm font-medium text-lx-text-primary hover:bg-[var(--lx-surface-card-hover)] rounded min-w-0 flex-1 truncate text-left" style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 6px 2px 0", margin: "-2px 0 -2px -4px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }} onClick={(e) => { e.stopPropagation(); setExpanded(isExpanded ? null : p.id); }}>
                            <ChevronDown size={12} strokeWidth={2} style={{ color: "var(--lx-text-secondary)", flexShrink: 0, transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 150ms var(--lx-ease-out)" }} />
                            <span className="truncate" title={p.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{p.label}</span>
                          </button>
                        </div>
                      </td>
                      <td className="font-mono text-xs text-lx-text-secondary">{bu}</td>
                      <td className="text-xs text-lx-text-secondary">{total === 0 ? "—" : `${enabled} enabled · ${total} total`}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="table-actions">
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
                          <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleFetch(p.id); }} disabled={fetchModels.isPending} title="Sync models from provider without expanding">
                            <RefreshCw size={12} strokeWidth={1.5} className={fetchModels.isPending ? "animate-spin" : undefined} />
                            Fetch
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); handleTest(p.id); }} disabled={test.isPending}>
                            Test
                          </button>
                          <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Edit provider" onClick={(e) => { e.stopPropagation(); startEdit(p); }}>
                            <Settings size={14} strokeWidth={1.5} />
                          </button>
                          <button type="button" className="btn btn-danger btn-icon-sm" aria-label="Delete provider" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(p.id); }}>
                            <Trash2 size={14} strokeWidth={1.5} />
                          </button>
                        </div>
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
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleFetch(p.id)} disabled={fetchModels.isPending}>
                                <RefreshCw size={12} strokeWidth={1.5} className={fetchModels.isPending ? "animate-spin" : undefined} />
                                Fetch models
                              </button>
                            </div>
                            <ProviderModelsTable providerId={p.id} models={models} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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

      {deleteConfirm && typeof document !== "undefined" && createPortal(
        <>
          <button type="button" className="dialog-overlay" onClick={() => setDeleteConfirm(null)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
            <div className="dialog dialog-enter pointer-events-auto" style={{ maxWidth: 420 }}>
              <h3 className="font-display text-base font-medium text-lx-text-primary">Delete provider?</h3>
              <p className="text-sm text-lx-text-secondary mt-2">This will permanently delete the provider. Projects referencing it will fail with 409 until reassigned.</p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid" disabled={del.isPending} onClick={() => del.mutate(deleteConfirm, { onSuccess: () => setDeleteConfirm(null) })}><Trash2 size={14} strokeWidth={1.5} /> {del.isPending ? "Deleting…" : "Delete"}</button>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </section>
  );
}

function ProviderModelsTable({ providerId, models }: { providerId: string; models: HeraldProviderModel[] }) {
  const reorder = useReorderProviderModels();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = models.findIndex((m) => m.id === String(active.id));
    const newIndex = models.findIndex((m) => m.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const ordered = arrayMove(models, oldIndex, newIndex);
    const orderedIds = ordered.map((m) => m.id);
    reorder.mutate({ providerId, orderedIds });
  };

  return (
    <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={models.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: 36 }}></th><th>Model ID</th><th style={{ width: 150 }}>Kind</th><th style={{ width: 70 }}>Priority</th><th style={{ width: 80 }}>Enabled</th></tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr><td colSpan={5} className="text-xs text-lx-text-muted" style={{ textAlign: "center", padding: 16 }}>No models — fetch from provider.</td></tr>
              ) : models.map((m) => (
                <SortableModelRow key={m.id} providerId={providerId} model={m} />
              ))}
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableModelRow({ providerId, model }: { providerId: string; model: HeraldProviderModel }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: model.id });
  const update = useUpdateProviderModel(providerId);
  const mid = model.modelId ?? (model as unknown as { model_id?: string }).model_id ?? model.id;
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : undefined }}
    >
      <td style={{ textAlign: "center" }}>
        <span
          {...attributes}
          {...listeners}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", color: "var(--lx-text-muted)", padding: 4 }}
          aria-label="Drag to reprioritize"
          title="Drag to reprioritize"
        >
          <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ color: "var(--lx-text-muted)", pointerEvents: "none" }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
        </span>
      </td>
      <td className="font-mono text-xs" style={{ color: model.enabled ? "var(--lx-text-primary)" : "var(--lx-text-secondary)" }}>{mid}</td>
      <td><span style={{ background: model.kind === "anthropic_compatible" ? "var(--lx-bg-success-subtle)" : model.kind === "openai_responses" ? "rgba(139, 92, 246, 0.12)" : "var(--lx-bg-accent-subtle)", color: model.kind === "anthropic_compatible" ? "var(--lx-text-success)" : model.kind === "openai_responses" ? "#a78bfa" : "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, fontSize: 11 }}>{model.kind}</span></td>
      <td className="font-mono text-xs text-lx-text-secondary">{model.priority}</td>
      <td>
        <button
          type="button"
          className={`toggle-switch${model.enabled ? " is-on" : ""}`}
          aria-label={model.enabled ? "Enabled" : "Disabled"}
          onClick={() => update.mutate({ modelId: mid, enabled: !model.enabled })}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </td>
    </tr>
  );
}
