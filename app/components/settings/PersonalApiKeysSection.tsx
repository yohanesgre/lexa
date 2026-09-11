import { useRef, useState } from "react";
import { Key, Plus, Trash2 } from "lucide-react";
import { useMyApiKeys, useCreateMyApiKey, useDeleteMyApiKey } from "../../lib/queries";
import { formatRelative } from "../../lib/relative-time";
import { ApiKeyRevealModal, DeleteKeyModal } from "./SettingsSections";

// Settings → Me → API Keys — own keys only (user-bound), any signed-in user.
// Transcribed from wireframes/src/settings-me.html.
function KeyCode({ children }: { children: string }) {
  return (
    <code style={{ fontFamily: "var(--lx-font-mono)", fontSize: 12, background: "var(--lx-surface-elevated)", padding: "2px 4px", borderRadius: 4, color: "var(--lx-text-secondary)" }}>
      {children}
    </code>
  );
}

export function PersonalApiKeysSection() {
  const { data: keys = [], isLoading, isError } = useMyApiKeys();
  const createKey = useCreateMyApiKey();
  const deleteKey = useDeleteMyApiKey();
  const [keyName, setKeyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const generateBtnRef = useRef<HTMLButtonElement>(null);

  const handleGenerate = () => {
    if (!keyName.trim()) {
      setError("Key name is required.");
      return;
    }
    setError(null);
    createKey.mutate(keyName.trim(), {
      onSuccess: (data) => {
        setReveal({ name: data.key.name, key: data.rawKey });
        setKeyName("");
      },
      onError: (err) => setError(err.message),
    });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">API Keys</h2>
        <span className="text-xs text-lx-text-muted">Own keys only</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Personal API keys for scripts, agents, and the CLI. A key acts as its owner — same project access as your session, never more. Device-login approvals (lx) mint keys here automatically.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load API keys.</div>
      ) : keys.length === 0 ? (
        <div className="card-panel">
          <div className="empty-state" style={{ padding: "28px 16px" }}>
            <div className="empty-state-icon">
              <Key size={24} strokeWidth={1.5} />
            </div>
            <h3 className="font-display text-lg font-medium text-lx-text-primary">No API keys yet</h3>
            <p className="text-sm text-lx-text-secondary mt-1" style={{ maxWidth: 300 }}>
              Create a key below — or pair the CLI with <KeyCode>lx login &lt;URL&gt;</KeyCode> and approve it right here.
            </p>
          </div>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last Used</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={deleting?.id === k.id ? { background: "var(--lx-bg-danger-subtle)" } : undefined}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Key size={14} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
                      <span className="text-sm font-medium">{k.name}</span>
                    </div>
                  </td>
                  <td>
                    <span className="font-mono text-xs text-lx-text-muted">lxk_••••••••••••••••••••••••••••••••</span>
                  </td>
                  <td className="text-xs text-lx-text-secondary">{k.createdAt.slice(0, 10)}</td>
                  <td className="text-xs text-lx-text-secondary">
                    {k.lastUsedAt ? formatRelative(k.lastUsedAt) : <span className="text-lx-text-muted">Never</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-danger btn-sm" title="Revoke key" aria-label={`Revoke key ${k.name}`} onClick={() => setDeleting(k)}>
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card-panel card-panel--elevated mt-4">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Create New Key</h3>
        {error && (
          <div className="notice notice-danger mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span>{error}</span>
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="prop-input"
            aria-label="Key name"
            placeholder="Key name (e.g. cli-myhost)"
            value={keyName}
            onChange={(e) => { setKeyName(e.target.value); if (error) setError(null); }}
            style={{ minWidth: 240, ...(error ? { borderColor: "var(--lx-text-danger)" } : {}) }}
          />
          <button
            ref={generateBtnRef}
            type="button"
            className="btn btn-primary"
            disabled={createKey.isPending || error !== null}
            onClick={handleGenerate}
          >
            <Plus size={14} strokeWidth={1.5} />
            {createKey.isPending ? "Generating…" : "Generate Key"}
          </button>
        </div>
        <div className="field-hint" style={{ marginTop: 8 }}>
          Key ini terikat ke akunmu — pakai <KeyCode>lx login &lt;URL&gt;</KeyCode> untuk masuk tanpa key manual.
        </div>
      </div>

      {reveal && (
        <ApiKeyRevealModal
          name={reveal.name}
          fullKey={reveal.key}
          onDone={() => {
            setReveal(null);
            generateBtnRef.current?.focus();
          }}
        />
      )}

      {deleting && (
        <DeleteKeyModal
          name={deleting.name}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteKey.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
          }}
        />
      )}
    </section>
  );
}