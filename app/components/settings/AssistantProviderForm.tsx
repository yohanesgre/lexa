import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useCreateProvider, useUpdateProvider } from "../../lib/queries/assistant-admin";
import type { AssistantProvider } from "../../../shared/assistant";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { providerBaseUrl, providerFormPayload, PROVIDER_PRESETS, activePreset } from "./assistant-providers-logic";

// Add/Edit provider card (wireframe admin-assistant-providers.html §provider API
// key states). Remounts per editing target (parent keys by provider id). The
// API key is write-only: the chip is the server-provided mask, an empty field
// keeps the stored key, and `clearKey` is the only removal route. When
// `secretsEnabled` is false the field renders disabled (never hidden) with the
// exact-env-var warning; a key-less save stays legal, and a stored key keeps its
// chip and Clear key trigger because clearing needs no key.
export function AssistantProviderForm({ editing, secretsEnabled, onCancel }: { editing: AssistantProvider | null; secretsEnabled: boolean | undefined; onCancel: () => void }) {
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const [label, setLabel] = useState(editing?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(() => providerBaseUrl(editing));
  const [apiKey, setApiKey] = useState("");
  const [clearPending, setClearPending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  const editingFlag = editing !== null;
  const secretsOn = secretsEnabled === true;
  const hasKey = (editing?.hasKey ?? false) && !clearPending;
  const mask = editing?.keyMask ?? "sk-…8f3a";
  const canSubmit = !!label.trim() && !!baseUrl.trim() && !create.isPending && !update.isPending;
  // The active mark is derived from the current field pair (wireframe: applying
  // writes Label + Base URL; editing either field clears it).
  const preset = activePreset(label, baseUrl);
  const presetActive = preset !== null;

  const handleSave = () => {
    const payload = providerFormPayload({ label, baseUrl, apiKey });
    if (!payload) return;
    if (editing) {
      const patch: { label: string; baseUrl: string; apiKey?: string; clearKey?: boolean } = { label: payload.label, baseUrl: payload.baseUrl };
      if (payload.apiKey) patch.apiKey = payload.apiKey;
      if (clearPending) patch.clearKey = true;
      update.mutate({ id: editing.id, ...patch }, { onSuccess: onCancel });
    } else {
      // A key-less create is legal and deliberate — the field may be empty.
      create.mutate({ label: payload.label, baseUrl: payload.baseUrl, apiKey: payload.apiKey ?? "" }, { onSuccess: onCancel });
    }
  };

  const placeholder = clearPending
    ? secretsOn
      ? "Type to cancel the pending clear"
      : "Save removes the stored key"
    : hasKey
      ? `Type to replace ${mask}`
      : "Paste the provider API key";

  return (
    <div className="card-panel card-panel--elevated mt-4">
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">{editingFlag ? "Edit provider" : "Add provider"}</h3>
      <div className="flex items-center gap-2 mb-3" style={{ flexWrap: "wrap" }}>
        <span className="prop-label">Preset</span>
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`btn btn-ghost btn-sm${preset?.label === p.label ? " is-active" : ""}`}
            aria-pressed={preset?.label === p.label}
            onClick={() => { setLabel(p.label); setBaseUrl(p.baseUrl); }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="provider-label">Label</label>
          <input id="provider-label" className="prop-input w-full" placeholder="OpenRouter" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="provider-base-url">Base URL</label>
          <input id="provider-base-url" className="prop-input w-full font-mono" placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          {preset?.label === "Cloudflare AI" && (
            <div className="field-hint">
              Replace <span className="font-mono">&lt;account_id&gt;</span> with the Cloudflare account id — it is part of the URL, not a separate field. The API token needs <strong>Workers AI</strong> access.
            </div>
          )}
        </div>
      </div>

      {secretsEnabled === false && (
        <div className="notice notice-warning mt-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>
            Key storage is turned off on this server, so provider keys can't be saved yet. An admin can turn it on.{clearPending ? " A pending removal can still be cancelled." : ""}
          </span>
        </div>
      )}

      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <label className="field-label" style={{ marginBottom: 0 }} htmlFor="provider-api-key">API key</label>
          {hasKey ? (
            <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
              Saved · <span className="font-mono">{mask}</span>
            </span>
          ) : !clearPending && secretsOn ? (
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{presetActive ? "operator-entered · write-only" : "write-only"}</span>
          ) : null}
        </div>
        <input
          id="provider-api-key"
          className="prop-input w-full font-mono"
          type="password"
          placeholder={placeholder}
          autoComplete="off"
          disabled={!secretsOn}
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); if (clearPending) setClearPending(false); }}
          style={{ maxWidth: 480 }}
        />
        <div className="field-hint">
          {clearPending
            ? secretsOn
              ? "Entering a value here cancels the pending clear — the stored key is kept, never cleared."
              : "The field stays disabled until the key is set, so the pending clear cannot be cancelled by typing."
            : hasKey
              ? "Empty keeps the stored key. Typing replaces it on Save — write-only, never read back."
              : presetActive
                ? "A preset never touches the key. Cloudflare AI wants an API token with Workers AI access; OpenCode Zen wants an OpenCode API key; OpenCode Go wants the Go-plan key. All three are typed by the operator, write-only, and never read back."
                : "No chip — nothing is stored yet. Saving with the field empty is a legal, deliberately key-less provider."}
        </div>

        {hasKey && (
          <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setClearConfirm(true)}>
              <Trash2 size={14} strokeWidth={1.5} />
              Clear key
            </button>
          </div>
        )}

        {clearPending && (
          <div className="notice notice-danger" style={{ marginTop: 10 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span>Key will be removed on Save.</span>
          </div>
        )}

        {clearPending && !secretsOn && (
          <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setClearPending(false)}>Keep key</button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSubmit}>
          Save provider
        </button>
        {editingFlag && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>

      {clearConfirm && editing && (
        <ConfirmDialog
          title="Clear API key?"
          body={
            <>
              Remove the stored API key from <span className="font-mono text-xs" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px", color: "var(--lx-text-primary)" }}>{editing.label}</span>. The next run calls the provider with no key, so every model starts failing with <span className="font-mono">PROVIDER_AUTH_FAILED</span>. The stored value is deleted, not archived, and it is never shown to you again. This cannot be undone.
            </>
          }
          confirmLabel="Clear key"
          onCancel={() => setClearConfirm(false)}
          onConfirm={() => { setClearConfirm(false); setClearPending(true); setApiKey(""); }}
        />
      )}
    </div>
  );
}
