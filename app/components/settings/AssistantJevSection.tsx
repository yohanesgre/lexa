import { useState } from "react";
import { Check, Trash2, XCircle, Zap } from "lucide-react";
import { useAssistantJevConfig, useUpdateAssistantJevConfig, useTestAssistantJev } from "../../lib/queries/assistant-admin";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { AssistantJevMasked } from "../../../shared/assistant";

// Workspace → Assistant Providers → Jev (wireframe admin-assistant-providers.html
// §Jev). Jev (Typesafe System 1) is a direct REST advisory backend, not an MCP
// client. One config row: base URL, model, enabled, and a write-only API key
// encrypted with the server secrets master key. Per-project opt-in lives in
// AssistantProjectJevSection.
type JevTestState =
  | { state: "pending" }
  | { state: "ok"; latencyMs: number; modelCount: number }
  | { state: "fail"; code: string };

// Fixed catalog copy — upstream text is never echoed.
function failureCopy(code: string): string {
  if (code === "JEV_AUTH_FAILED") return "The key was rejected — or Jev couldn't be reached.";
  if (code === "JEV_UNREACHABLE") return "Jev could not be reached (timeout / network).";
  if (code === "JEV_INVALID_CONFIG") return "The Jev configuration is invalid.";
  if (code === "SECRET_KEY_UNAVAILABLE") return "Key storage is turned off on this server.";
  return "Jev test failed.";
}

export function AssistantJevSection() {
  const { data, isLoading, isError } = useAssistantJevConfig();
  // A failed BACKGROUND refetch reports `isError` while cached data is still
  // present; swapping that for the error copy would unmount the form and drop
  // unsaved edits. Only a first-load failure (no data) is an error surface.
  const showError = isError && !data;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Jev</h2>
          <span className="text-xs text-lx-text-muted">superadmin-gated</span>
        </div>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>

      {showError ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-muted py-6 text-center">Could not load Jev configuration.</div>
        </div>
      ) : isLoading || !data ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-muted py-6 text-center">Loading…</div>
        </div>
      ) : (
        <JevConfigForm config={data.config} secretsEnabled={data.secretsEnabled} />
      )}
    </section>
  );
}

function JevConfigForm({ config, secretsEnabled }: { config: AssistantJevMasked; secretsEnabled: boolean }) {
  const update = useUpdateAssistantJevConfig();
  const test = useTestAssistantJev();

  const [enabled, setEnabled] = useState(config.enabled);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [secret, setSecret] = useState("");
  const [clearPending, setClearPending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [testState, setTestState] = useState<JevTestState | null>(null);

  const secretsOn = secretsEnabled === true;
  const hasKey = config.hasKey && !clearPending;
  const mask = config.keyMask ?? "jev-…4f2a";

  const handleSave = () => {
    const patch: { baseUrl: string; model: string; enabled: boolean; secret?: string; clearSecret?: boolean } = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      enabled,
    };
    if (secret.trim()) patch.secret = secret.trim();
    if (clearPending) patch.clearSecret = true;
    update.mutate(patch, {
      onSuccess: () => {
        setSecret("");
        setClearPending(false);
      },
    });
  };

  const handleTest = () => {
    setTestState({ state: "pending" });
    test.mutate(undefined, {
      onSuccess: (res) => setTestState({ state: "ok", latencyMs: res.latencyMs, modelCount: res.models.length }),
      onError: (err) => setTestState({ state: "fail", code: (err as { code?: string }).code ?? "JEV_UNREACHABLE" }),
    });
  };

  const placeholder = clearPending
    ? secretsOn
      ? "Type to cancel the pending clear"
      : "Save removes the stored key"
    : hasKey
      ? `Type to replace ${mask}`
      : "Paste the Jev API key";

  return (
    <div className="card-panel card-panel--elevated">
      <div className="flex items-center justify-between mb-3">
        <span className="prop-label">Enabled</span>
        <button
          type="button"
          className={`toggle-switch${enabled ? " is-on" : ""}`}
          aria-label={enabled ? "Jev enabled" : "Jev disabled"}
          aria-pressed={enabled}
          onClick={() => setEnabled((v) => !v)}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="jev-base-url">Base URL</label>
          <input id="jev-base-url" className="prop-input w-full font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <div className="field-hint">Full https:// address, no username or password. Defaults to <span className="font-mono">https://api.typesafe.ai</span>.</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="jev-model">Model</label>
          <input id="jev-model" className="prop-input w-full font-mono" value={model} onChange={(e) => setModel(e.target.value)} />
          <div className="field-hint">Trimmed, 1–120 characters. Seeded default <span className="font-mono">jev-latest</span>.</div>
        </div>
      </div>

      {secretsEnabled === false && (
        <div className="notice notice-warning mt-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>Key storage is turned off on this server, so Jev API keys can't be saved yet. An admin can turn it on.</span>
        </div>
      )}

      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <label className="field-label" style={{ marginBottom: 0 }} htmlFor="jev-api-key">API key</label>
          {hasKey ? (
            <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
              Saved · <span className="font-mono">{mask}</span>
            </span>
          ) : !clearPending && secretsOn ? (
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">write-only</span>
          ) : null}
        </div>
        <input
          id="jev-api-key"
          className="prop-input w-full font-mono"
          type="password"
          placeholder={placeholder}
          autoComplete="off"
          disabled={!secretsOn}
          value={secret}
          onChange={(e) => { setSecret(e.target.value); if (clearPending) setClearPending(false); }}
          style={{ maxWidth: 480 }}
        />
        <div className="field-hint">
          {clearPending
            ? secretsOn
              ? "Entering a value here cancels the pending clear — the stored key is kept, never cleared."
              : "The field stays disabled until the key is set, so the pending clear cannot be cancelled by typing."
            : hasKey
              ? "Empty keeps the stored key. Typing replaces it on Save — write-only, never read back."
              : "No chip — nothing is stored yet. Saving with the field empty is legal; Test then fails until a key is saved and the config is enabled."}
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
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={update.isPending}>Save</button>
        <button type="button" className="btn btn-ghost" onClick={handleTest} disabled={test.isPending}>
          <Zap size={12} strokeWidth={1.5} />
          Test
        </button>
      </div>

      {testState && (
        <div
          className={`card-row card-row--${testState.state === "ok" ? "success" : testState.state === "fail" ? "danger" : "neutral"}`}
          style={{ marginTop: 12, width: 260 }}
        >
          {testState.state === "pending" ? (
            <>
              <div className="flex items-center gap-2">
                <span className="spinner" />
                <span className="text-xs font-medium text-lx-text-primary">Testing…</span>
              </div>
              <div className="text-xs text-lx-text-secondary mt-1">Probing the models list with the stored key</div>
            </>
          ) : testState.state === "ok" ? (
            <>
              <div className="flex items-center gap-2">
                <Check size={14} strokeWidth={2.5} style={{ color: "var(--lx-text-success)" }} />
                <span className="text-xs font-medium text-lx-text-primary">OK · {testState.latencyMs} ms</span>
              </div>
              <div className="text-xs text-lx-text-secondary mt-1">{testState.modelCount} models available</div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <XCircle size={14} strokeWidth={2} style={{ color: "var(--lx-text-danger)" }} />
                <span className="text-xs font-medium text-lx-text-danger font-mono">{testState.code}</span>
              </div>
              <div className="text-xs text-lx-text-secondary mt-1">{failureCopy(testState.code)}</div>
            </>
          )}
        </div>
      )}

      {!enabled && !config.hasKey && (
        <div className="card-panel mt-3" style={{ background: "var(--lx-surface-elevated)" }}>
          <span className="text-sm font-medium text-lx-text-primary">Jev is not configured</span>
          <p className="text-xs text-lx-text-secondary mt-1">Add a base URL, model, and API key, then enable Jev to turn on the advisory preflight and the <span className="font-mono">jev_assess</span> tool.</p>
        </div>
      )}

      {clearConfirm && (
        <ConfirmDialog
          title="Clear Jev API key?"
          body={
            <>
              Remove the Jev API key from your saved settings. Every preflight and <span className="font-mono">jev_assess</span> call then runs key-less — the advisory is skipped and the tool is not offered. The stored value is deleted, not archived, and it is never shown to you again. This cannot be undone.
            </>
          }
          confirmLabel="Clear key"
          onCancel={() => setClearConfirm(false)}
          onConfirm={() => { setClearConfirm(false); setClearPending(true); setSecret(""); }}
        />
      )}
    </div>
  );
}
