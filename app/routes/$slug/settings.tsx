import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Check, Copy, Key, Plus, Trash2 } from "lucide-react";

interface MockKey {
  id: string;
  name: string;
  created: string;
  lastUsed: string | null;
}

const mockKeys: MockKey[] = [
  { id: "1", name: "Hermes Production", created: "2026-07-15", lastUsed: "2026-07-27T14:30:00Z" },
  { id: "2", name: "CI Deploy Bot", created: "2026-07-20", lastUsed: "2026-07-26T09:15:00Z" },
  { id: "3", name: "Local Dev (MK)", created: "2026-07-25", lastUsed: null },
];

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  return `${d}d ago`;
}

function ApiKeyRevealModal({ name, fullKey, onDone }: { name: string; fullKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="slideover-overlay" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true" style={{ maxWidth: 464 }}>
          <div className="modal-header">
            <span className="modal-title">API Key Created</span>
            <span className="wip-badge wip-ok">NEW</span>
          </div>

          <div className="modal-body">
            <div className="mb-4">
              <label className="field-label">Name</label>
              <div className="text-sm font-medium text-lx-text-primary">{name}</div>
            </div>

            <div className="mb-4">
              <label className="field-label">Key</label>
              <div className="key-display">
                <code>{fullKey}</code>
                <button
                  type="button"
                  className="btn btn-ghost flex-shrink-0"
                  style={{ height: 28, padding: "0 10px", fontSize: 12 }}
                  onClick={() => { void navigator.clipboard.writeText(fullKey); setCopied(true); }}
                >
                  {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="field-hint">Full key is shown here exactly once — in the table it is always masked.</div>
            </div>

            <div className="notice notice-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>This key will not be shown again. Copy it now and store it somewhere safe — Lexa stores only a SHA-256 hash.</span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onDone}>Done</button>
          </div>
        </div>
      </div>
    </>
  );
}

function DeleteKeyModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete API key?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This will permanently delete{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}— agents and integrations using this key will lose access immediately. This action cannot be undone.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Delete
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsPage() {
  const [keyName, setKeyName] = useState("");
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<MockKey | null>(null);

  return (
    <main className="page-frame">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-6">Settings</h1>

      <section>
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-2">API Keys</h2>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Machine authentication for MCP agents and integrations. Keys are hashed with SHA-256 before storage. Only the full key is shown once on creation.
        </p>

        {mockKeys.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 text-center mb-4" style={{ background: "var(--lx-surface-card)", border: "1px dashed var(--lx-border-strong)", borderRadius: 8, padding: 32 }}>
            <Key size={20} strokeWidth={1.5} className="text-lx-text-muted" />
            <div className="text-sm font-medium text-lx-text-primary mt-1">No API keys yet</div>
            <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 360 }}>
              Generate a key below to connect Hermes, OpenCode, or other MCP agents to this project.
            </p>
          </div>
        ) : (
          <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
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
                {mockKeys.map((k) => (
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
                    <td className="text-xs text-lx-text-secondary">{k.created}</td>
                    <td className="text-xs text-lx-text-secondary">
                      {k.lastUsed ? formatRelative(k.lastUsed) : <span className="text-lx-text-muted">Never</span>}
                    </td>
                    <td>
                      <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" onClick={() => setDeleting(k)}>
                        <Trash2 size={12} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: 16 }}>
          <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Create New Key</h3>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              className="prop-input"
              placeholder="Key name (e.g. Hermes Staging)"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!keyName.trim()}
              onClick={() => {
                setReveal({ name: keyName.trim(), key: `lxk_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}` });
                setKeyName("");
              }}
            >
              <Plus size={14} strokeWidth={1.5} />
              Generate Key
            </button>
          </div>
        </div>
      </section>

      {reveal && (
        <ApiKeyRevealModal name={reveal.name} fullKey={reveal.key} onDone={() => setReveal(null)} />
      )}

      {deleting && (
        <DeleteKeyModal name={deleting.name} onCancel={() => setDeleting(null)} onConfirm={() => setDeleting(null)} />
      )}
    </main>
  );
}

function RouteComponent() {
  return <SettingsPage />;
}

export const Route = createFileRoute("/$slug/settings")({
  component: RouteComponent,
});
