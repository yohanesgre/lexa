import { useState, useRef, useEffect } from "react";
import { AlertTriangle, Check, Copy, Key, Plus, RotateCcw, Settings, Trash2, Search, UserPlus, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useApiKeys, useCreateApiKey, useDeleteApiKey, useUsers, useUpdateUserRole, useProjectMembers, useAddProjectMember, useRemoveProjectMember, useDeleteProject, useRuntimes, useRemoveRuntime } from "../../lib/queries";
import { RuntimeSetupModal } from "../forge/RuntimeSetupModal";
import { RuntimeEditModal } from "../forge/RuntimeEditModal";
import { RuntimeRestartModal } from "../forge/RuntimeRestartModal";
import { AgentsSettingsSection, SkillsSettingsSection } from "../forge/AgentSkillSettings";
import { copyToClipboard } from "../../lib/clipboard";
import type { Runtime } from "../../../shared/types";
import * as api from "../../lib/api";
import { parseApiDate } from "../../lib/date";

function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
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

  useEffect(() => {
    void copyToClipboard(fullKey).then(() => setCopied(true));
  }, [fullKey]);

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
                  onClick={() => { void copyToClipboard(fullKey).then(() => setCopied(true)); }}
                >
                  {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
                  {copied ? "Copied to clipboard" : "Copy"}
                </button>
              </div>
              <div className="field-hint">Auto-copied to your clipboard. Keep it somewhere safe — Lexa stores only a SHA-256 hash.</div>
            </div>

            <div className="notice notice-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>This key will not be shown again. Copy it now and store it somewhere safe.</span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onDone}>I've saved this key</button>
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

function RemoveRuntimeModal({ name, hostname, onCancel, onConfirm }: { name: string; hostname: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove runtime?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Remove{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {hostname ? ` (${hostname})` : ""} from the runtimes list? The machine listener will stop its child daemon and clean up its runtime files.
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

function DemoteAdminModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Demote admin?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Demote{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}from admin to member? They will lose global admin access and can be re-added to specific projects.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Demote
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function AddAdminModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Promote to admin?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Promote{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}to global admin? They will be removed from all per-project member lists.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={onConfirm}>
              <Plus size={14} strokeWidth={1.5} />
              Promote
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function AddMemberModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Add member?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Add{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}to this project? They will gain access immediately.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={onConfirm}>
              <Plus size={14} strokeWidth={1.5} />
              Add
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function DeleteProjectModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const [input, setInput] = useState("");

  useEffect(() => { setInput(""); }, [name]);

  return (
    <>
      <div className="slideover-overlay" onClick={onCancel} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" role="dialog" aria-modal="true" style={{ maxWidth: 420 }}>
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete project?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This permanently deletes{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}and all its tasks, columns, swimlanes, wiki pages, and member assignments. This action cannot be undone.
          </p>

          <label className="field-label mt-4">Type <strong>{name}</strong> to confirm</label>
          <input
            className="prop-input mt-1"
            placeholder={name}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ width: "100%" }}
          />

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm} disabled={input !== name}>
              <Trash2 size={14} strokeWidth={1.5} />
              Delete Project
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

function MembersTable({ slug }: { slug: string }) {
  const { data: members = [], isLoading } = useProjectMembers(slug);
  const { data: project } = useQuery({ queryKey: ["project", slug], queryFn: () => api.getProject(slug) });
  const { data: users = [] } = useUsers();
  const removeMember = useRemoveProjectMember(slug);
  const [removing, setRemoving] = useState<string | null>(null);

  if (isLoading) return <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>;

  if (members.length === 0) {
    return (
      <div className="empty-box mb-4">
        <Users size={20} strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }} />
        <div className="text-sm font-medium text-lx-text-primary">No members yet</div>
        <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 300 }}>Add members below to grant them access. Admins have full access automatically.</p>
      </div>
    );
  }

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
          onConfirm={() => {
            const member = members.find((m) => m.name === removing);
            const user = member ? users.find((u) => u.email === member.email) : undefined;
            if (user && project) removeMember.mutate({ userId: user.id, projectId: project.id });
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}

function ProjectBoundSettings({ slug }: { slug: string }) {
  const { data: users = [] } = useUsers();
  const { data: members = [] } = useProjectMembers(slug);
  const { data: project } = useQuery({ queryKey: ["project", slug], queryFn: () => api.getProject(slug) });
  const addMember = useAddProjectMember(slug);
  const [memberQuery, setMemberQuery] = useState("");
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [adding, setAdding] = useState<{ id: string; name: string } | null>(null);
  const memberEmails = new Set(members.map((m) => m.email));
  const memberSuggestions = users.filter(
    (u) => u.role !== "admin" && !memberEmails.has(u.email) && (u.email.includes(memberQuery) || u.name.toLowerCase().includes(memberQuery.toLowerCase()))
  );

  const deleteProject = useDeleteProject();
  const [deletingProject, setDeletingProject] = useState(false);

  return (
    <>
      {/* Project Members (per-project scope) */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Project Members</h2>
          <span className="text-xs text-lx-text-muted">Per project</span>
        </div>
        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-sm text-lx-text-secondary" style={{ maxWidth: 560, marginBottom: 0 }}>
            Manage which team members can access this project. Changes take effect immediately.
          </p>
          <div style={{ position: "relative", minWidth: 240, flexShrink: 0 }}>
            <input
              className="prop-input"
              placeholder="Add member..."
              style={{ width: "100%" }}
              value={memberQuery}
              onChange={(e) => { setMemberQuery(e.target.value); setShowMemberDropdown(true); }}
              onFocus={() => setShowMemberDropdown(true)}
            />
            <span className="text-xs text-lx-text-muted" style={{ display: "block", marginTop: 4 }}>Type a name or email to add.</span>
            {showMemberDropdown && (
              <InlineDropdown
                items={memberSuggestions.map((u) => ({ name: u.name, email: u.email }))}
                onSelect={(email) => {
                  const user = memberSuggestions.find((u) => u.email === email);
                  if (user) setAdding({ id: user.id, name: user.name });
                  setMemberQuery("");
                  setShowMemberDropdown(false);
                }}
                onClose={() => setShowMemberDropdown(false)}
              />
            )}
          </div>
        </div>

        <MembersTable slug={slug} />
      </section>

      {/* Project Management */}
      <section className="mb-8">
        <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Project</h2>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Manage this project's settings. Deleting a project removes all tasks, columns, swimlanes, wiki pages, and member assignments permanently.
        </p>

        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "16px 20px" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-sm font-medium text-lx-text-primary">{project?.name}</div>
              <div className="text-xs text-lx-text-secondary">slug: {project?.slug}</div>
            </div>
            <button type="button" className="btn btn-danger h-7 px-3 text-xs" onClick={() => setDeletingProject(true)}>
              <Trash2 size={12} strokeWidth={1.5} />
              Delete Project
            </button>
          </div>
        </div>
      </section>

      {adding && (
        <AddMemberModal
          name={adding.name}
          onCancel={() => setAdding(null)}
          onConfirm={() => {
            if (project) addMember.mutate({ userId: adding.id, projectId: project.id }, { onSuccess: () => setAdding(null) });
          }}
        />
      )}

      {deletingProject && project && (
        <DeleteProjectModal
          name={project.name}
          onCancel={() => setDeletingProject(false)}
          onConfirm={() => {
            deleteProject.mutate(project.slug, {
              onSuccess: () => { setDeletingProject(false); window.location.href = "/"; },
            });
          }}
        />
      )}
    </>
  );
}

export function SettingsPage({ slug }: { slug?: string }) {
  const { data: keys = [], isLoading, isError } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const { data: runtimes = [], isLoading: runtimesLoading, isError: runtimesError } = useRuntimes();
  const [setupOpen, setSetupOpen] = useState(false);
  const [editing, setEditing] = useState<Runtime | null>(null);
  const [restarting, setRestarting] = useState<Runtime | null>(null);
  const removeRuntime = useRemoveRuntime();
  const [removing, setRemoving] = useState<Runtime | null>(null);
  const { data: users = [] } = useUsers();
  const demote = useUpdateUserRole();
  const admins = users.filter((u) => u.role === "admin");
  const promote = useUpdateUserRole();
  const [adminQuery, setAdminQuery] = useState("");
  const [showAdminDropdown, setShowAdminDropdown] = useState(false);
  const [promoting, setPromoting] = useState<{ id: string; name: string } | null>(null);
  const adminSuggestions = users.filter(
    (u) => u.role !== "admin" && (u.email.includes(adminQuery) || u.name.toLowerCase().includes(adminQuery.toLowerCase()))
  );

  const [keyName, setKeyName] = useState("");
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [demoting, setDemoting] = useState<{ id: string; name: string } | null>(null);

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

      {/* Agents (global) — rule bundles */}
      <AgentsSettingsSection />

      {/* Skills (global) — operation bundles */}
      <SkillsSettingsSection />

      {/* Agent Runtimes (global) */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Agent Runtimes</h2>
          <div className="flex items-center gap-3">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Global scope</span>
            <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setSetupOpen(true)}>
              <Plus size={14} strokeWidth={1.5} />
              Setup runtime
            </button>
          </div>
        </div>
        <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
          Machines running the Forge daemon (AI writing assistant). The daemon spawns the installed agent CLI (opencode / hermes / command-code) when a Forge task is queued.
        </p>

        {runtimesLoading ? (
          <div className="text-sm text-lx-text-muted py-8 text-center">Loading runtimes…</div>
        ) : runtimesError ? (
          <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load runtimes.</div>
        ) : runtimes.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 text-center mb-4" style={{ background: "var(--lx-surface-card)", border: "1px dashed var(--lx-border-strong)", borderRadius: 8, padding: 24 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="text-lx-text-muted"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /></svg>
            <div className="text-sm font-medium text-lx-text-primary mt-1">No runtimes yet</div>
            <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
              Connect a machine with an agent CLI installed (opencode, hermes, or command-code). Setup generates the exact env + start command.
            </p>
            <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12, marginTop: 8 }} onClick={() => setSetupOpen(true)}>
              <Plus size={14} strokeWidth={1.5} />
              Setup runtime
            </button>
          </div>
        ) : (
          <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>CLI</th>
                  <th>Model</th>
                  <th>Hostname</th>
                  <th>Status</th>
                  <th>MCP</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runtimes.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /></svg>
                        <span className="text-sm font-medium">{r.name}</span>
                      </div>
                    </td>
                    <td className="text-xs text-lx-text-secondary">{r.provider}</td>
                    <td className="font-mono text-xs text-lx-text-secondary">{r.model || "—"}</td>
                    <td className="font-mono text-xs text-lx-text-secondary">{r.hostname || "—"}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className={r.status === "online" ? "sync-dot sync-synced" : "sync-dot sync-unlinked"} />
                        <span className={`font-micro text-2xs uppercase tracking-[0.04em] ${r.status === "online" ? "text-lx-text-success" : "text-lx-text-muted"}`}>
                          {r.status === "online" ? "Online" : "Offline"}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className={`font-micro text-2xs uppercase tracking-[0.04em] ${r.mcpConnected ? "text-lx-text-success" : "text-lx-text-muted"}`}>
                        {r.mcpConnected ? "Connected" : "Not set"}
                      </span>
                    </td>
                    <td className="text-xs text-lx-text-secondary">{r.lastSeen ? formatRelative(r.lastSeen) : <span className="text-lx-text-muted">Never</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {r.status === "offline" && (
                        <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0, fontSize: 12 }} onClick={() => setRestarting(r)} aria-label={`Restart ${r.name}`} title="Restart guide — how to bring this daemon back">
                          <RotateCcw size={14} strokeWidth={1.5} />
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0, fontSize: 12 }} onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} title="Edit runtime">
                        <Settings size={14} strokeWidth={1.5} />
                      </button>
                      <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0, fontSize: 12, opacity: r.status === "offline" || !r.machineId ? 0.45 : 1 }} disabled={r.status === "offline" || !r.machineId} onClick={() => setRemoving(r)} aria-label={`Remove ${r.name}`} title={r.status === "offline" ? "Machine offline — restart its listener before removing" : !r.machineId ? "Runtime has no registered machine" : "Remove runtime"}>
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Admins (app scope) */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Admins</h2>
          <span className="text-xs text-lx-text-muted">App scope</span>
        </div>
        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-sm text-lx-text-secondary" style={{ maxWidth: 560, marginBottom: 0 }}>
            Global administrators — promoted from registered users. Admins have full access to all projects and settings. Admins are automatically excluded from per-project member lists.
          </p>
          <div style={{ position: "relative", minWidth: 240, flexShrink: 0 }}>
            <input
              className="prop-input"
              placeholder="Add admin..."
              style={{ width: "100%" }}
              value={adminQuery}
              onChange={(e) => { setAdminQuery(e.target.value); setShowAdminDropdown(true); }}
              onFocus={() => setShowAdminDropdown(true)}
            />
            <span className="text-xs text-lx-text-muted" style={{ display: "block", marginTop: 4 }}>Type a name or email to promote.</span>
            {showAdminDropdown && (
              <InlineDropdown
                items={adminSuggestions.map((u) => ({ name: u.name, email: u.email }))}
                onSelect={(email) => {
                  const user = adminSuggestions.find((u) => u.email === email);
                  if (user) setPromoting({ id: user.id, name: user.name });
                  setAdminQuery("");
                  setShowAdminDropdown(false);
                }}
                onClose={() => setShowAdminDropdown(false)}
              />
            )}
          </div>
        </div>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 80 }}>Role</th><th style={{ width: 80 }} /></tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="avatar">{a.name[0]}</div>
                      <span className="text-sm font-medium">{a.name}</span>
                    </div>
                  </td>
                  <td className="text-xs text-lx-text-secondary">{a.email}</td>
                  <td>
                    <span className="text-xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>{a.role}</span>
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" onClick={() => setDemoting({ id: a.id, name: a.name })}>
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {slug && <ProjectBoundSettings slug={slug} />}

      {reveal && (
        <ApiKeyRevealModal name={reveal.name} fullKey={reveal.key} onDone={() => setReveal(null)} />
      )}

      {setupOpen && (
        <RuntimeSetupModal onClose={() => setSetupOpen(false)} />
      )}

      {editing && (
        <RuntimeEditModal runtime={editing} onClose={() => setEditing(null)} />
      )}

      {restarting && (
        <RuntimeRestartModal runtime={restarting} onClose={() => setRestarting(null)} />
      )}

      {removing && (
        <RemoveRuntimeModal
          name={removing.name}
          hostname={removing.hostname}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeRuntime.mutate(removing.id, { onSuccess: () => setRemoving(null) });
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

      {demoting && (
        <DemoteAdminModal
          name={demoting.name}
          onCancel={() => setDemoting(null)}
          onConfirm={() => {
            demote.mutate({ id: demoting.id, role: "member" }, { onSuccess: () => setDemoting(null) });
          }}
        />
      )}

      {promoting && (
        <AddAdminModal
          name={promoting.name}
          onCancel={() => setPromoting(null)}
          onConfirm={() => {
            promote.mutate({ id: promoting.id, role: "admin" }, { onSuccess: () => setPromoting(null) });
          }}
        />
      )}
    </main>
  );
}
