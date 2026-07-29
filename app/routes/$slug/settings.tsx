import { useState, useRef, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Check, Copy, Key, Plus, Trash2, Search, UserPlus } from "lucide-react";
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from "../../lib/queries";

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

function RemoveMemberModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove member?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Remove{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}from this project? They will lose access immediately.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function InlineDropdown({ items, onSelect, onClose }: { items: { name: string; email: string }[]; onSelect: (email: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  if (items.length === 0) return null;
  return (
    <div ref={ref} className="dropdown-menu" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10 }}>
      <div className="dropdown-label">Users</div>
      {items.map((u) => (
        <div key={u.email} className="dropdown-item" onClick={() => onSelect(u.email)}>
          <span>{u.name}</span>
          <span className="text-xs text-lx-text-secondary">{u.email}</span>
        </div>
      ))}
    </div>
  );
}

function AdminAddForm() {
  const [query, setQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  // Mock suggestions — replace with real user list
  const suggestions = [{ name: "Dani", email: "dani@yohanesgre.com" }, { name: "Danika", email: "danika@example.com" }].filter(
    (u) => u.email.includes(query) || u.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="mt-4 p-4" style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8 }}>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Add Admin</h3>
      <div style={{ position: "relative" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="prop-input"
            placeholder="Search by email..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            style={{ minWidth: 240 }}
          />
          <button type="button" className="btn btn-primary" disabled={!query.trim()}>
            <Plus size={14} strokeWidth={1.5} />
            Add
          </button>
        </div>
        {showDropdown && <InlineDropdown items={suggestions} onSelect={(email) => { setQuery(email); setShowDropdown(false); }} onClose={() => setShowDropdown(false)} />}
      </div>
      <div className="text-xs text-lx-text-muted mt-2">Promotes an existing user to admin. They will be removed from all per-project member lists.</div>
    </div>
  );
}

function MemberAddForm() {
  const [query, setQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const suggestions = [{ name: "Alice", email: "alice@example.com" }, { name: "Bob", email: "bob@example.com" }].filter(
    (u) => u.email.includes(query) || u.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="mt-4 p-4" style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8 }}>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Add Member</h3>
      <div style={{ position: "relative" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="prop-input"
            placeholder="Search by email..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            style={{ minWidth: 240 }}
          />
          <button type="button" className="btn btn-primary" disabled={!query.trim()}>
            <Plus size={14} strokeWidth={1.5} />
            Add
          </button>
        </div>
        {showDropdown && <InlineDropdown items={suggestions} onSelect={(email) => { setQuery(email); setShowDropdown(false); }} onClose={() => setShowDropdown(false)} />}
      </div>
      <div className="text-xs text-lx-text-muted mt-2">Search existing users by email. Admins are excluded from member suggestions.</div>
    </div>
  );
}

function MembersPopulated() {
  const [removing, setRemoving] = useState<string | null>(null);
  const members = [
    { name: "Alice", email: "alice@example.com", role: "member" as const },
    { name: "Bob", email: "bob@example.com", role: "member" as const },
  ];

  return (
    <>
      <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
        <table className="settings-table">
          <thead>
            <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 80 }}>Role</th><th style={{ width: 80 }} /></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.email} style={removing === m.name ? { background: "var(--lx-bg-danger-subtle)" } : undefined}>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="avatar">{m.name[0]}</div>
                    <span className="text-sm font-medium">{m.name}</span>
                  </div>
                </td>
                <td className="text-xs text-lx-text-secondary">{m.email}</td>
                <td>
                  <span className="text-xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>{m.role}</span>
                </td>
                <td>
                  <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" onClick={() => setRemoving(m.name)}>
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {removing && (
        <RemoveMemberModal
          name={removing}
          onCancel={() => setRemoving(null)}
          onConfirm={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function SettingsPage() {
  const { data: keys = [], isLoading, isError } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const [keyName, setKeyName] = useState("");
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  return (
    <main className="page-frame">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-6">Settings</h1>

      <section className="mb-8">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-2">API Keys</h2>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Machine authentication for MCP agents and integrations. Keys are hashed with SHA-256 before storage. Only the full key is shown once on creation.
        </p>

        {isLoading ? (
          <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
        ) : isError ? (
          <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load API keys.</div>
        ) : keys.length === 0 ? (
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
              disabled={!keyName.trim() || createKey.isPending}
              onClick={() =>
                createKey.mutate(keyName.trim(), {
                  onSuccess: (data) => {
                    setReveal({ name: data.key.name, key: data.rawKey });
                    setKeyName("");
                  },
                })
              }
            >
              <Plus size={14} strokeWidth={1.5} />
              {createKey.isPending ? "Generating…" : "Generate Key"}
            </button>
          </div>
        </div>
      </section>

      {reveal && (
        <ApiKeyRevealModal name={reveal.name} fullKey={reveal.key} onDone={() => setReveal(null)} />
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

      {/* Admins (app scope) */}
      <section className="mb-8">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-2">Admins</h2>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Global administrators — promoted from registered users. Admins have full access to all projects and settings. Admins are automatically excluded from per-project member lists.
        </p>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 80 }}>Role</th><th style={{ width: 80 }} /></tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="avatar">Y</div>
                    <span className="text-sm font-medium">Yohanes</span>
                  </div>
                </td>
                <td className="text-xs text-lx-text-secondary">yohanesgre@gmail.com</td>
                <td>
                  <span className="text-xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>admin</span>
                </td>
                <td>
                  <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger">
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
              <tr>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="avatar">L</div>
                    <span className="text-sm font-medium">Lexa</span>
                  </div>
                </td>
                <td className="text-xs text-lx-text-secondary">lexa@yohanesgre.com</td>
                <td>
                  <span className="text-xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>admin</span>
                </td>
                <td>
                  <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger">
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <AdminAddForm />
      </section>

      {/* Project Members (per-project scope) */}
      <section className="mb-8">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-2">Project Members</h2>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Manage which team members can access this project. Changes take effect immediately.
        </p>

        <MembersPopulated />

        <MemberAddForm />
      </section>
    </main>
  );
}

function RouteComponent() {
  return <SettingsPage />;
}

export const Route = createFileRoute("/$slug/settings")({
  component: RouteComponent,
});
