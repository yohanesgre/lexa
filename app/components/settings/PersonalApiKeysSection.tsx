import { useRef, useState } from "react";
import { AlertTriangle, Copy, Key, Plus, Trash2 } from "lucide-react";
import { useMyApiKeys, useCreateMyApiKey, useDeleteMyApiKey, useCapabilities } from "../../lib/queries";
import { copyToClipboard } from "../../lib/clipboard";
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
  const capabilities = useCapabilities();
  const [keyName, setKeyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const generateBtnRef = useRef<HTMLButtonElement>(null);
  const mcpUrl = capabilities.data?.mcpUrl;
  const keysLoaded = !isLoading && !isError;

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

  const handleCopyMcpUrl = async () => {
    if (!mcpUrl) return;
    setCopyState((await copyToClipboard(mcpUrl)) ? "copied" : "failed");
  };

  return (
    <section className="mb-8 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">API Keys</h2>
        <span className="text-xs text-lx-text-muted">Own keys only</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Keys let scripts, agents, and the CLI work with your account. Each key has exactly your project access — never more. Signing in from the CLI (lx) creates one here automatically.
      </p>

      <div className="card-panel mb-4">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-1">Connect an MCP client</h3>
        <p className="text-sm text-lx-text-secondary mb-3" style={{ maxWidth: 560 }}>
          Use Streamable HTTP with this URL and a personal API key.
        </p>

        <div className="field-label" id="mcp-url-label">MCP server URL</div>
        {mcpUrl ? (
          <>
            <div className="key-display" role="group" aria-labelledby="mcp-url-label">
              <code>{mcpUrl}</code>
              <button
                type="button"
                className="btn btn-ghost flex-shrink-0"
                style={{ minHeight: "var(--lx-row-h-touch)", padding: "0 12px", fontSize: 12 }}
                onClick={() => void handleCopyMcpUrl()}
              >
                <Copy size={12} strokeWidth={1.5} />
                Copy MCP URL
              </button>
            </div>
            <div role="status" aria-live="polite" aria-atomic="true">
              {copyState === "copied" && <div className="field-hint">MCP URL copied.</div>}
              {copyState === "failed" && <div className="field-hint field-hint-danger">Could not copy the URL. Select and copy it manually.</div>}
            </div>
          </>
        ) : capabilities.isLoading ? (
          <div className="text-sm text-lx-text-muted">Loading…</div>
        ) : (
          <div className="text-sm text-lx-text-secondary">Could not load the MCP server URL. Reload the page and try again.</div>
        )}

        <div className="notice notice-warning mt-3">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <span>This key gives the client the same permissions as your account. Use a separate key for OpenBot so you can revoke it independently.</span>
        </div>

        {mcpUrl && (
          <>
            <p className="text-sm text-lx-text-secondary mt-3" style={{ maxWidth: 560 }}>
              A key by itself is not a connection. In OpenBot:
            </p>
            <ol className="text-sm text-lx-text-secondary" style={{ listStyle: "decimal", paddingLeft: 20, margin: "4px 0 0", maxWidth: 560, lineHeight: 1.5 }}>
              <li>Create a personal key named OpenBot below and copy it when it is shown.</li>
              <li>Set Name to Lexa, Transport to Streamable HTTP, and Server URL to the MCP server URL above.</li>
              <li>Add the header <KeyCode>Authorization</KeyCode> with the value <KeyCode>Bearer &lt;personal-api-key&gt;</KeyCode>.</li>
              <li>Leave Sign-in app empty when using an API key.</li>
              <li>Select Test connection, then ask OpenBot to list projects.</li>
            </ol>
          </>
        )}
        <div className="field-hint">Keys are shown only once. If you no longer have the key, create a new one.</div>
        {keysLoaded && keys.length === 0 && (
          <div className="field-hint">Create a key named OpenBot below, then paste it into OpenBot as an Authorization header.</div>
        )}
      </div>

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