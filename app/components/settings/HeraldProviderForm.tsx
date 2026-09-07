import { useState } from "react";
import { useCreateProvider, useUpdateProvider } from "../../lib/queries/herald-admin";
import type { HeraldProvider } from "../../../shared/herald";
import { canSubmitProviderForm, providerBaseUrl, providerFormPayload } from "./herald-providers-logic";

// Add/Edit provider card. Remounts per editing target (parent keys by
// provider id); empty key input keeps the stored key on edit.
export function HeraldProviderForm({ editing, onCancel }: { editing: HeraldProvider | null; onCancel: () => void }) {
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const [label, setLabel] = useState(editing?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(() => providerBaseUrl(editing));
  const [apiKey, setApiKey] = useState("");

  const editingFlag = editing !== null;
  const state = { label, baseUrl, apiKey };

  const handleSave = () => {
    const payload = providerFormPayload(state);
    if (!payload) return;
    if (editing) {
      const patch: { label: string; baseUrl: string; apiKey?: string } = { label: payload.label, baseUrl: payload.baseUrl };
      if (payload.apiKey) patch.apiKey = payload.apiKey;
      update.mutate({ id: editing.id, ...patch } as never, { onSuccess: onCancel });
    } else if (payload.apiKey) {
      create.mutate({ label: payload.label, baseUrl: payload.baseUrl, apiKey: payload.apiKey }, { onSuccess: onCancel });
    }
  };

  return (
    <div className="card-panel card-panel--elevated mt-4">
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">{editingFlag ? "Edit provider" : "Add provider"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="provider-label">Label</label>
          <input id="provider-label" className="prop-input w-full" placeholder="OpenRouter" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="provider-base-url">Base URL</label>
          <input id="provider-base-url" className="prop-input w-full font-mono" placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
      </div>
      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <label className="field-label" style={{ marginBottom: 0 }} htmlFor="provider-api-key">API key</label>
          {editing?.hasKey && (
            <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
              Saved · <span className="font-mono">{editing.keyMask ?? "sk-…8f3a"}</span>
            </span>
          )}
        </div>
        <input id="provider-api-key" className="prop-input w-full font-mono" type="password" placeholder={editing?.hasKey ? `Type to replace ${editing.keyMask ?? "sk-…8f3a"}` : "sk-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ maxWidth: 480 }} />
        <div className="field-hint">Empty keeps the stored key. Typing replaces it on Save — write-only, never read back.</div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!canSubmitProviderForm(state, editingFlag) || create.isPending || update.isPending}
        >
          Save provider
        </button>
        {editingFlag && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
