import { useState, useRef, useEffect } from "react";
import { AlertTriangle, Check, Copy, Key, Plus, RotateCcw, Settings, Trash2, Search, Upload, UserPlus, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useApiKeys, useCreateApiKey, useDeleteApiKey, useUsers, useUpdateUserRole, useProjectMembers, useAddProjectMember, useRemoveProjectMember, useDeleteProject, useRuntimes, useMachines, useRemoveRuntime, useRemoveMachine, useRateLimit, useUpdateRateLimit, useGithubSettings, useUpdateGithubSettings, useClearGithubSettings, useProjects, useProjectRepos, useReplaceProjectRepos, useGithubRepoSearch } from "../../lib/queries";
import { RuntimeSetupModal } from "../forge/RuntimeSetupModal";
import { RuntimeEditModal } from "../forge/RuntimeEditModal";
import { RuntimeRestartModal } from "../forge/RuntimeRestartModal";
import { AgentsSettingsSection, SkillsSettingsSection } from "../forge/AgentSkillSettings";
import { copyToClipboard } from "../../lib/clipboard";
import type { Runtime, Machine, ProjectRepo } from "../../../shared/types";
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
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopyKey = async () => {
    const ok = await copyToClipboard(fullKey);
    if (ok) {
      setCopied(true);
    } else {
      setCopyFailed(true);
    }
  };

  return (
    <>
      <div className="slideover-overlay" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto p-0" aria-modal="true" aria-labelledby="api-key-reveal-title" style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}>
          <div className="modal-header">
            <span className="modal-title" id="api-key-reveal-title">API Key Created</span>
            <span className="wip-badge wip-ok">NEW</span>
          </div>

          <div className="modal-body">
            <div className="mb-4">
              <div className="field-label">Name</div>
              <div className="text-sm font-medium text-lx-text-primary">{name}</div>
            </div>

            <div className="mb-4">
              <div className="field-label">Key</div>
              <div className="key-display">
                <code>{fullKey}</code>
                <button
                  type="button"
                  className="btn btn-ghost flex-shrink-0"
                  style={{ height: 28, padding: "0 10px", fontSize: 12 }}
                  onClick={handleCopyKey}
                  autoFocus
                >
                  {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
                  {copied ? "Copied to clipboard" : "Copy"}
                </button>
              </div>
              <div className="field-hint">Full key is shown here exactly once — in the table it is always masked.</div>
              {copyFailed && (
                <div className="field-hint field-hint-danger">Clipboard blocked — select the key below and copy it manually.</div>
              )}
            </div>

            <div className="notice notice-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>This key will not be shown again. Copy it now and store it somewhere safe.</span>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onDone}>Done</button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function DeleteKeyModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
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
        </dialog>
      </div>
    </>
  );
}

function RemoveGithubSyncModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove GitHub sync?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This removes the stored App ID, private key, and webhook secret. GitHub sync stops immediately — already-linked issues stay linked but stop syncing. This action cannot be undone.
          </p>

          <p className="text-sm text-lx-text-secondary mt-2 leading-5">
            If{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              GITHUB_*
            </span>
            {" "}environment variables are set on the server, they are re-imported on the next restart.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function RemoveLinkedRepoModal({ repo, onCancel, onConfirm }: { repo?: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">{repo ? "Remove repo?" : "Remove all repos?"}</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            {repo ? (
              <>
                Remove{" "}
                <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
                  {repo}
                </span>
                {" "}from this project? Existing task↔issue links keep syncing.
              </>
            ) : (
              "Remove all repos from this project? Existing task↔issue links keep syncing."
            )}
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function RemoveMemberModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
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
        </dialog>
      </div>
    </>
  );
}

function RemoveRuntimeModal({ name, hostname, onCancel, onConfirm }: { name: string; hostname: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove runtime?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Remove{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {hostname ? ` (${hostname})` : ""} from the runtimes list? The server queues a remove event — the machine's listener stops the daemon and cleans up its runtime files on its next heartbeat.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function RemoveMachineModal({ id, runtimeCount, onCancel, onConfirm }: { id: string; runtimeCount: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Remove machine?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Remove{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {id}
            </span>
            {runtimeCount > 0 ? ` and its ${runtimeCount} runtime${runtimeCount === 1 ? "" : "s"}` : ""}?
            Their daemons are stopped by the machine listener on its next heartbeat.
          </p>
          <p className="text-sm mt-2 leading-5" style={{ color: "var(--lx-text-warning, #d97706)" }}>
            If the listener is still running on that machine, it will reappear within seconds — run{" "}
            <span className="font-mono text-xs">lexa-cli machine stop</span> there first for permanent removal.
          </p>

          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
              <Trash2 size={14} strokeWidth={1.5} />
              Remove
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function DemoteAdminModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
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
        </dialog>
      </div>
    </>
  );
}

function AddAdminModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
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
        </dialog>
      </div>
    </>
  );
}

function AddMemberModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
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
        </dialog>
      </div>
    </>
  );
}

function DeleteProjectModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const [input, setInput] = useState("");

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog" style={{ maxWidth: 420 }}>
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete project?</h2>

          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This permanently deletes{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}and all its tasks, columns, swimlanes, wiki pages, and member assignments. This action cannot be undone.
          </p>

          <label className="field-label mt-4" htmlFor="confirm-delete">Type <strong>{name}</strong> to confirm</label>
          <input
            id="confirm-delete"
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
        </dialog>
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
        <button key={u.email} type="button" className="dropdown-item w-full text-left" onClick={() => onSelect(u.email)}>
          <span>{u.name}</span>
          <span className="text-xs text-lx-text-secondary">{u.email}</span>
        </button>
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
                  <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" aria-label={`Remove ${m.name} from project`} onClick={() => setRemoving(m.name)}>
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
              aria-label="Add member"
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

function AdminsSection({ users, onPromote, onDemote }: { users: { id: string; email: string; name: string; role: "admin" | "member" }[]; onPromote: (id: string, name: string) => void; onDemote: (id: string, name: string) => void }) {
  const admins = users.filter((u) => u.role === "admin");
  const [query, setQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const suggestions = users.filter(
    (u) => u.role !== "admin" && (u.email.includes(query) || u.name.toLowerCase().includes(query.toLowerCase()))
  );
  return (
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
            aria-label="Add admin"
            placeholder="Add admin..."
            style={{ width: "100%" }}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
          />
          <span className="text-xs text-lx-text-muted" style={{ display: "block", marginTop: 4 }}>Type a name or email to promote.</span>
          {showDropdown && (
            <InlineDropdown
              items={suggestions.map((u) => ({ name: u.name, email: u.email }))}
              onSelect={(email) => {
                const user = suggestions.find((u) => u.email === email);
                if (user) onPromote(user.id, user.name);
                setQuery("");
                setShowDropdown(false);
              }}
              onClose={() => setShowDropdown(false)}
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
                  <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" aria-label={`Remove ${a.name} from admins`} onClick={() => onDemote(a.id, a.name)}>
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Rate Limiting (app scope — admin only), per wireframes/src/settings.html.
// Hidden for non-admins; the env override renders as a plain text note above
// the form when an env var supplies the effective values.
function RateLimitSection() {
  const { data, isLoading, isError } = useRateLimit();
  const save = useUpdateRateLimit();
  const [max, setMax] = useState("");
  const [windowMin, setWindowMin] = useState("");
  const synced = useRef(false);

  useEffect(() => {
    if (data && !synced.current) {
      synced.current = true;
      setMax(String(data.max));
      setWindowMin(String(data.windowMs / 60000));
    }
  }, [data]);

  const maxNum = Number(max);
  const windowNum = Number(windowMin);
  // Mirrors the server validation (integers, max >= 1, windowMs >= 1000) so
  // Save is only offered once the inputs can succeed; the server stays
  // authoritative and surfaces 422s via the error toast.
  const canSave = Number.isInteger(maxNum) && maxNum >= 1 && Number.isFinite(windowNum) && windowNum * 60000 >= 1000;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Rate Limiting</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-lx-text-muted">App scope</span>
        </div>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Per-client-IP request budget for the API and MCP surfaces. Applies to /api and /mcp; Forge machine surfaces are exempt. Changes apply immediately — no restart needed.
      </p>

      {data?.envOverride && (
        <p className="text-xs text-lx-text-muted mb-2">
          Active values come from the <span className="font-mono">LXK_RATE_LIMIT_MAX</span> / <span className="font-mono">LXK_RATE_LIMIT_WINDOW_MS</span> environment variables. Saving new values below overrides them.
        </p>
      )}

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load rate limit settings.</div>
      ) : (
        <div style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: 16 }}>
          <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Request Budget</h3>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="rate-limit-max">Max requests</label>
              <div className="flex items-center gap-2">
                <input
                  id="rate-limit-max"
                  className="prop-input"
                  type="number"
                  min={1}
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  style={{ width: 96, textAlign: "right" }}
                />
                <span className="text-xs text-lx-text-secondary">per IP per window</span>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="rate-limit-window">Window</label>
              <div className="flex items-center gap-2">
                <input
                  id="rate-limit-window"
                  className="prop-input"
                  type="number"
                  value={windowMin}
                  onChange={(e) => setWindowMin(e.target.value)}
                  style={{ width: 96, textAlign: "right" }}
                />
                <span className="text-xs text-lx-text-secondary">minutes</span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSave || save.isPending}
              onClick={() => save.mutate({ max: maxNum, windowMs: Math.round(windowNum * 60000) })}
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// GitHub Sync (app scope — admin only), per wireframes/src/settings.html.
// Hidden for non-admins; the env-source hint renders as a plain text note
// above the form. The API never returns the key or secret — the secret input
// is write-only (never prefilled) and the private key is file-upload only.
function GithubSyncSection() {
  const { data, isLoading, isError } = useGithubSettings();
  const save = useUpdateGithubSettings();
  const remove = useClearGithubSettings();
  const [removing, setRemoving] = useState(false);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [secretTouched, setSecretTouched] = useState(false);
  const [pemName, setPemName] = useState("");
  const [pemText, setPemText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const synced = useRef(false);

  useEffect(() => {
    if (data && !synced.current) {
      synced.current = true;
      setAppId(data.appId);
    }
  }, [data]);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setPemName(file.name);
      setPemText(String(reader.result ?? ""));
    };
    reader.readAsText(file);
  };

  // The remove control only appears when something is stored — nothing to
  // remove otherwise (per wireframes/src/settings.html annotation).
  const configured = !!data && (data.appId !== "" || data.privateKeySet || data.webhookSecretSet);

  const resetForm = () => {
    setAppId("");
    setSecret("");
    setSecretTouched(false);
    setPemName("");
    setPemText("");
  };

  // Mirrors the server validation (appId digits, privateKey must include
  // "-----BEGIN"); the secret never blocks save — untouched = omitted,
  // empty = clear, typed = replace. The server stays authoritative and
  // surfaces 422s via the error toast.
  const appIdOk = /^\d+$/.test(appId);
  const pemOk = pemText === "" || pemText.includes("-----BEGIN");
  const canSave = appIdOk && pemOk;

  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/github` : "";

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">GitHub Sync</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-lx-text-muted">App scope</span>
        </div>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Two-way issue sync between GitHub and Lexa boards. Configured with GitHub App credentials; webhook deliveries are HMAC-verified against the webhook secret.
      </p>

      {data?.source === "env" && (
        <p className="text-xs text-lx-text-muted mb-2">
          Active values come from the <span className="font-mono">GITHUB_APP_ID</span> / <span className="font-mono">GITHUB_PRIVATE_KEY</span> / <span className="font-mono">GITHUB_PRIVATE_KEY_FILE</span> / <span className="font-mono">GITHUB_WEBHOOK_SECRET</span> environment variables. Saving new values below overrides them.
        </p>
      )}

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load GitHub sync settings.</div>
      ) : (
        <>
          <div style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: 16 }}>
            <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Credentials</h3>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="github-app-id">App ID</label>
                <input
                  id="github-app-id"
                  className="prop-input"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  style={{ width: 110 }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label" htmlFor="github-webhook-secret">Webhook secret</label>
                <input
                  id="github-webhook-secret"
                  className="prop-input font-mono"
                  placeholder={data?.webhookSecretSet ? "••••••••••••••••" : "Set once, never displayed"}
                  value={secret}
                  onChange={(e) => { setSecret(e.target.value); setSecretTouched(true); }}
                  style={{ width: 220, fontSize: 12 }}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSave || save.isPending}
                onClick={() => save.mutate({
                  appId,
                  ...(pemText !== "" ? { privateKey: pemText } : {}),
                  ...(secretTouched ? { webhookSecret: secret } : {}),
                })}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>

            <div className="field mt-4" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="github-pem">Private key</label>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-ghost" style={{ height: 32, padding: "0 12px", fontSize: 12 }} onClick={() => fileRef.current?.click()}>
                  <Upload size={14} strokeWidth={1.5} />
                  Choose .pem file
                </button>
                <input
                  id="github-pem"
                  ref={fileRef}
                  type="file"
                  accept=".pem,text/plain"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
                <span className={`font-mono text-xs ${pemName ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>{pemName || "No file chosen"}</span>
              </div>
              <div className="field-hint">Uploaded as a file, never pasted. The PEM is stored server-side; the API only reports whether a key is set.</div>
            </div>

            {configured && (
              <div className="mt-4">
                <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setRemoving(true)}>
                  <Trash2 size={14} strokeWidth={1.5} />
                  Remove GitHub sync
                </button>
              </div>
            )}
          </div>
          <p className="text-xs text-lx-text-muted mt-2">
            Webhook URL: <span className="font-mono">{webhookUrl}</span> — the GitHub App's webhook must deliver here (Content type application/json, secret = webhook secret above).
          </p>
        </>
      )}

      {removing && (
        <RemoveGithubSyncModal
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                setRemoving(false);
                resetForm();
              },
            })
          }
        />
      )}
    </section>
  );
}

// Linked Repos (per-project, admin), per wireframes/src/settings.html.
// All mutations are one full-replace PUT via useReplaceProjectRepos — the
// hook owns the cache update (setQueryData from the mutation response).
function LinkedReposSection({ slug }: { slug?: string }) {
  const { data: projects = [] } = useProjects();
  const [selectedSlug, setSelectedSlug] = useState(slug ?? "");
  const { data: repos = [], isLoading } = useProjectRepos(selectedSlug);
  const replaceRepos = useReplaceProjectRepos();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [removingRepo, setRemovingRepo] = useState<string | null>(null);
  const [removingAll, setRemovingAll] = useState(false);
  const search = useGithubRepoSearch(query);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHighlight(0);
  }, [search.data]);

  useEffect(() => {
    function handleClick(e: MouseEvent) { if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const pickRepo = (name: string) => {
    setQuery(name);
    setDropdownOpen(false);
  };

  const addRepo = () => {
    const name = query.trim();
    if (!name || !selectedSlug) return;
    const next = repos.some((r) => r.repo === name)
      ? repos.map((r) => (r.repo === name ? { ...r, workspaceRole: true } : r))
      : [...repos, { repo: name, sourceRole: false, workspaceRole: true }];
    replaceRepos.mutate({ slug: selectedSlug, repos: next });
    setQuery("");
    setDropdownOpen(false);
  };

  const toggleRole = (repo: string, role: "sourceRole" | "workspaceRole") => {
    if (!selectedSlug) return;
    replaceRepos.mutate({ slug: selectedSlug, repos: repos.map((r) => (r.repo === repo ? { ...r, [role]: !r[role] } : r)) });
  };

  const results = search.data ?? [];

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Linked Repos</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Repos this project can read (source — Forge agent context) and sync issues with (workspace — linking, creating, and two-way state/content sync). Repos must be accessible to the installed GitHub App; the type-ahead only shows repos the App is installed on.
      </p>

      <div style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: 16 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="linked-repos-project">Project</label>
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <select
              id="linked-repos-project"
              className="prop-input"
              value={selectedSlug}
              onChange={(e) => { setSelectedSlug(e.target.value); setQuery(""); setDropdownOpen(false); }}
              style={{ minWidth: 220 }}
            >
              {!selectedSlug && <option value="" disabled>Select a project…</option>}
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
            <span className="font-mono text-xs text-lx-text-secondary">slug: {selectedSlug || "—"}</span>
          </div>
        </div>

        <div className="field mt-4" style={{ marginBottom: 0 }}>
          <label className="field-label">Repos</label>
          {isLoading ? (
            <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
          ) : repos.length === 0 ? (
            <p className="text-sm text-lx-text-muted">No repos linked — add one above.</p>
          ) : (
            repos.map((r) => (
              <div key={r.repo} className="repo-row" style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", marginBottom: 8, flexWrap: "wrap" }}>
                <span className="font-mono text-sm font-medium text-lx-text-primary" style={{ minWidth: 180 }}>{r.repo}</span>
                <div style={{ display: "flex", gap: 14, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
                  <label className="text-sm text-lx-text-secondary" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={r.sourceRole} onChange={() => toggleRole(r.repo, "sourceRole")} style={{ accentColor: "var(--lx-text-link)" }} /> Source
                  </label>
                  <label className="text-sm text-lx-text-secondary" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={r.workspaceRole} onChange={() => toggleRole(r.repo, "workspaceRole")} style={{ accentColor: "var(--lx-text-link)" }} /> Issue workspace
                  </label>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemovingRepo(r.repo)}>Remove</button>
                </div>
              </div>
            ))
          )}

          <div className="flex items-center gap-2 mt-3" style={{ flexWrap: "wrap" }}>
            <div ref={dropdownRef} style={{ position: "relative", flex: 1, minWidth: 260 }}>
              <input
                className="prop-input w-full"
                placeholder="Search repos…"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setDropdownOpen(true); }}
                onFocus={() => setDropdownOpen(true)}
                onKeyDown={(e) => {
                  if (results.length === 0) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % results.length); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + results.length) % results.length); }
                  else if (e.key === "Enter" && dropdownOpen) { e.preventDefault(); pickRepo(results[highlight]); }
                  else if (e.key === "Escape") { setDropdownOpen(false); }
                }}
                style={{ width: "100%" }}
              />
              {dropdownOpen && query.trim().length >= 2 && results.length > 0 && (
                <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 6, zIndex: 5, overflow: "hidden" }}>
                  {results.map((repo, i) => (
                    <button
                      key={repo}
                      type="button"
                      onClick={() => pickRepo(repo)}
                      onMouseEnter={() => setHighlight(i)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        fontFamily: "var(--lx-font-mono, monospace)",
                        fontSize: 12,
                        ...(i === highlight
                          ? { background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }
                          : { color: "var(--lx-text-secondary)" }),
                      }}
                    >
                      {repo}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="btn btn-primary" disabled={!query.trim()} onClick={addRepo}>Add repo</button>
          </div>
          <div className="field-hint">Type-ahead over repos the GitHub App is installed on. Each repo needs at least one role. Removing a repo does not unlink existing task↔issue links — those keep syncing.</div>
        </div>

        <div className="field mt-4" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="forge-repo-cap">Forge source-repo cap</label>
          <input id="forge-repo-cap" className="prop-input" defaultValue="3" style={{ width: 80 }} />
          <div className="field-hint">Max source repos feeding a Forge agent claim (env bootstrap LXK_FORGE_REPO_CAP, default 3).</div>
        </div>

        <div className="mt-4">
          <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemovingAll(true)}>
            <Trash2 size={14} strokeWidth={1.5} />
            Remove all repos
          </button>
        </div>
      </div>

      {removingRepo && (
        <RemoveLinkedRepoModal
          repo={removingRepo}
          onCancel={() => setRemovingRepo(null)}
          onConfirm={() => {
            if (selectedSlug) replaceRepos.mutate({ slug: selectedSlug, repos: repos.filter((r) => r.repo !== removingRepo) });
            setRemovingRepo(null);
          }}
        />
      )}
      {removingAll && (
        <RemoveLinkedRepoModal
          onCancel={() => setRemovingAll(false)}
          onConfirm={() => {
            if (selectedSlug) replaceRepos.mutate({ slug: selectedSlug, repos: [] });
            setRemovingAll(false);
          }}
        />
      )}
    </section>
  );
}

export function SettingsPage({ slug }: { slug?: string }) {
  const { data: keys = [], isLoading, isError } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const { data: runtimes = [], isLoading: runtimesLoading, isError: runtimesError } = useRuntimes();
  const { data: machines = [] } = useMachines();
  const [setupOpen, setSetupOpen] = useState(false);
  const [editing, setEditing] = useState<Runtime | null>(null);
  const [restarting, setRestarting] = useState<Runtime | null>(null);
  const removeRuntime = useRemoveRuntime();
  const [removing, setRemoving] = useState<Runtime | null>(null);
  const removeMachine = useRemoveMachine();
  const [removingMachine, setRemovingMachine] = useState<Machine | null>(null);
  const { data: users = [] } = useUsers();
  const demote = useUpdateUserRole();
  const promote = useUpdateUserRole();
  const [promoting, setPromoting] = useState<{ id: string; name: string } | null>(null);

  // Admin-only sections (Rate Limiting, GitHub Sync): render when there is no
  // known user (local dev / Access-less deployments have no lxk-user meta) or
  // the user is admin; hide only from known members. The endpoints are
  // admin-gated server-side, so a member's 403 surfaces via the error toast.
  const user = api.clientLxkUser();
  const showAdminSections = !user || user.role === "admin";

  const [keyName, setKeyName] = useState("");
  const [reveal, setReveal] = useState<{ name: string; key: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [demoting, setDemoting] = useState<{ id: string; name: string } | null>(null);
  const generateBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <main className="page-frame">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-6">Settings</h1>

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
          Machines running the Forge daemon. The daemon spawns the installed agent CLI when a Forge task is queued.
        </p>
        {machines.length > 0 && (
          <div className="mb-4" style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
            <div className="flex items-center justify-between" style={{ padding: "10px 12px 0" }}>
              <h3 className="font-display text-sm font-medium text-lx-text-primary">Machines</h3>
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Hosts</span>
            </div>
            <table className="settings-table">
              <thead><tr><th>Machine</th><th>State</th><th>Runtimes</th><th>CLIs</th><th>Last seen</th><th /></tr></thead>
              <tbody>
                {machines.map((m) => {
                  const listening = !!m.lastSeen && Date.now() - parseApiDate(m.lastSeen).getTime() < 2 * 60 * 1000;
                  const runtimeCount = runtimes.filter((r) => r.machineId === m.id).length;
                  return (
                    <tr key={m.id}>
                      <td className="text-sm font-medium">{m.id}</td>
                      <td><span className="flex items-center gap-2"><span className={listening ? "sync-dot sync-synced" : "sync-dot sync-unlinked"} /><span className={`font-micro text-2xs uppercase tracking-[0.04em] ${listening ? "text-lx-text-success" : "text-lx-text-muted"}`}>{listening ? "Listening" : m.lastSeen ? "Offline" : "Bound, not listening"}</span></span></td>
                      <td className="text-xs text-lx-text-secondary">{runtimeCount ? `${runtimeCount} runtime${runtimeCount === 1 ? "" : "s"}` : "—"}</td>
                      <td className="font-mono text-xs text-lx-text-secondary">{m.clis?.length ? m.clis.map((c) => `${c.provider} ${c.version}`).join(" · ") : "—"}</td>
                      <td className="text-xs text-lx-text-secondary">{m.lastSeen ? formatRelative(m.lastSeen) : <span className="text-lx-text-muted">Never</span>}</td>
                      <td style={{ textAlign: "right" }}><button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setRemovingMachine(m)} aria-label={`Remove machine ${m.id}`} title="Remove machine"><Trash2 size={14} strokeWidth={1.5} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {runtimesLoading ? (
          <div className="text-sm text-lx-text-muted py-8 text-center">Loading runtimes…</div>
        ) : runtimesError ? (
          <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load runtimes.</div>
        ) : runtimes.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 text-center mb-4" style={{ background: "var(--lx-surface-card)", border: "1px dashed var(--lx-border-strong)", borderRadius: 8, padding: 24 }}>
            <div className="text-sm font-medium text-lx-text-primary">No runtimes yet</div>
            <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>Connect a machine with opencode, hermes, or command-code installed, then set up a runtime.</p>
            <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12, marginTop: 8 }} onClick={() => setSetupOpen(true)}><Plus size={14} strokeWidth={1.5} />Setup runtime</button>
          </div>
        ) : (
          <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
            <table className="settings-table">
              <thead><tr><th>Name</th><th>CLI</th><th>Model</th><th>Hostname</th><th>Status</th><th>MCP</th><th>Last seen</th><th /></tr></thead>
              <tbody>
                {runtimes.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm font-medium">{r.name}</td>
                    <td className="text-xs text-lx-text-secondary">{r.provider}</td>
                    <td className="font-mono text-xs text-lx-text-secondary">{r.model || "—"}</td>
                    <td className="font-mono text-xs text-lx-text-secondary">{r.hostname || "—"}</td>
                    <td><span className="flex items-center gap-2"><span className={r.status === "online" ? "sync-dot sync-synced" : "sync-dot sync-unlinked"} /><span className={`font-micro text-2xs uppercase tracking-[0.04em] ${r.status === "online" ? "text-lx-text-success" : "text-lx-text-muted"}`}>{r.status === "online" ? "Online" : "Offline"}</span></span>{r.lastError && <span className="block text-xs mt-1" style={{ color: "var(--lx-text-warning)" }}>{r.lastError.toLowerCase().includes("api key") ? "API key revoked — re-run Setup runtime" : r.lastError}</span>}</td>
                    <td><span className={`font-micro text-2xs uppercase tracking-[0.04em] ${r.mcpConnected ? "text-lx-text-success" : "text-lx-text-muted"}`}>{r.mcpConnected ? "Connected" : "Not set"}</span></td>
                    <td className="text-xs text-lx-text-secondary">{r.lastSeen ? formatRelative(r.lastSeen) : <span className="text-lx-text-muted">Never</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{r.status === "offline" && <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setRestarting(r)} aria-label={`Restart ${r.name}`} title="Restart guide"><RotateCcw size={14} strokeWidth={1.5} /></button>}<button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} title="Edit runtime"><Settings size={14} strokeWidth={1.5} /></button><button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setRemoving(r)} aria-label={`Remove ${r.name}`} title="Remove runtime"><Trash2 size={14} strokeWidth={1.5} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
                      <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" aria-label={`Delete key ${k.name}`} onClick={() => setDeleting(k)}>
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
              aria-label="Key name"
              placeholder="Key name (e.g. Hermes Staging)"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <button
              ref={generateBtnRef}
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

      {/* Admins (app scope) */}
      <AdminsSection
        users={users}
        onPromote={(id, name) => setPromoting({ id, name })}
        onDemote={(id, name) => setDemoting({ id, name })}
      />

      {/* Rate Limiting (app scope — admin only) */}
      {showAdminSections && <RateLimitSection />}

      {/* GitHub Sync (app scope — admin only) */}
      {showAdminSections && <GithubSyncSection />}

      {/* Linked Repos (per-project — admin only) */}
      {showAdminSections && <LinkedReposSection slug={slug} />}

      {slug && <ProjectBoundSettings slug={slug} />}

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

      {removingMachine && (
        <RemoveMachineModal
          id={removingMachine.id}
          runtimeCount={runtimes.filter((r) => r.machineId === removingMachine.id).length}
          onCancel={() => setRemovingMachine(null)}
          onConfirm={() => {
            removeMachine.mutate(removingMachine.id, { onSuccess: () => setRemovingMachine(null) });
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
