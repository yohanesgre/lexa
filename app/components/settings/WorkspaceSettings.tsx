import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Plus, Trash2, Users } from "lucide-react";
import { useSession, useWorkspaceMembers, useUpdateWorkspaceMember, useDeleteWorkspaceMember, useWorkspaceInvites, useCreateWorkspaceInvite, useRevokeWorkspaceInvite, useCreateSetPasswordLink, useTeams, useCreateTeam, useDeleteTeam, useProjects } from "../../lib/queries";
import { ApiKeysSection, GithubSyncSection, RateLimitSection, type GithubReturnResult } from "./SettingsSections";
import { AssistantProvidersSection } from "./AssistantProvidersSection";
import { AssistantMcpSection } from "./AssistantMcpSection";
import { formatRelative } from "../../lib/relative-time";
import { parseApiDate } from "../../lib/date";
import { AgentsSettingsSection, SkillsSettingsSection } from "./assistant/AgentSkillSettings";
import { copyToClipboard } from "../../lib/clipboard";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { Project, WorkspaceInvite } from "../../../shared/types";
import type { EmailDeliveryOutcome, WorkspaceMember } from "../../lib/api";

// Superadmin-only workspace settings: Members + invites, Teams, API keys,
// rate limiting, GitHub sync, Assistant providers, agents & skills.
// NO Superadmins section — superadmin is env-only (LXK_ADMIN_EMAILS).

// Same absolute date shape the wiki share dialog uses for future expiries.
const EXPIRY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function deliveryLine(email: EmailDeliveryOutcome): string {
  switch (email.status) {
    case "accepted":
      return "Email submitted to Cloudflare. Inbox delivery is not guaranteed.";
    case "failed":
      return "Link created, but email could not be sent. Copy and share the link.";
    case "unknown":
      return "Link created. Email submission could not be confirmed. Copy and share the link.";
    case "not_configured":
      return "Email is not configured. Copy and share the link.";
    default:
      return "Copy and share the link.";
  }
}

function LinkCopyModal({ title, link, email, onDone, restoreFocus }: {
  title: string;
  link: string;
  email: EmailDeliveryOutcome;
  onDone: () => void;
  restoreFocus?: (() => HTMLElement | null) | undefined;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Trap Tab in the dialog; focus return is owned below because the invite
  // opener is disabled by the time the dialog closes.
  useOverlayFocusTrap(true, dialogRef);

  const restoreFocusRef = useRef(restoreFocus);
  restoreFocusRef.current = restoreFocus;
  useEffect(() => {
    return () => {
      if (dialogRef.current?.isConnected) return; // dev effect replay, not a close
      queueMicrotask(() => restoreFocusRef.current?.()?.focus());
    };
  }, []);

  // Keep the latest close handler without re-running the mount-time listener.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDoneRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(link);
    setCopied(ok);
    setCopyFailed(!ok);
  };
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onDone} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog ref={dialogRef} open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label={title} style={{ maxWidth: 460, width: "calc(100vw - 48px)" }}>
          <h2 className="font-display text-lg font-medium text-lx-text-primary">{title}</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">{deliveryLine(email)}</p>
          <p className="text-xs text-lx-text-muted mt-1">Single-use, expires after 7 days.</p>
          <div className="key-display mt-3">
            <code>{link}</code>
          </div>
          {copyFailed && (
            <div className="field-hint-danger" role="alert">Could not copy. Select and copy the link.</div>
          )}
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" style={{ height: 44 }} onClick={onDone}>Close</button>
            <button type="button" className="btn btn-primary" style={{ height: 44 }} onClick={handleCopy}>
              {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
              {copied ? "Copied to clipboard" : "Copy link"}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

function WorkspaceMembersSection() {
  const { data: members = [], isLoading } = useWorkspaceMembers();
  const { data: session } = useSession();
  const updateMember = useUpdateWorkspaceMember();
  const deleteMember = useDeleteWorkspaceMember();
  const setPasswordLink = useCreateSetPasswordLink();
  const invites = useWorkspaceInvites();
  const createInvite = useCreateWorkspaceInvite();
  const revokeInvite = useRevokeWorkspaceInvite();
  const [inviteEmail, setInviteEmail] = useState("");
  const [deleting, setDeleting] = useState<WorkspaceMember | null>(null);
  const [linkModal, setLinkModal] = useState<{ kind: "invite" | "set-password"; title: string; link: string; email: EmailDeliveryOutcome } | null>(null);
  const inviteButtonRef = useRef<HTMLButtonElement | null>(null);
  const inviteEmailInputRef = useRef<HTMLInputElement | null>(null);
  const setPasswordOpenerRef = useRef<HTMLButtonElement | null>(null);

  const currentUserId = session?.session?.userId;

  const handleSetPassword = (m: WorkspaceMember, opener: HTMLButtonElement) => {
    setPasswordOpenerRef.current = opener;
    setPasswordLink.mutate(m.id, {
      onSuccess: (res) => setLinkModal({ kind: "set-password", title: `Set-password link for ${m.email}`, link: res.link, email: res.email }),
    });
  };

  const handleInvite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    createInvite.mutate(email, {
      onSuccess: (res) => {
        setInviteEmail("");
        setLinkModal({ kind: "invite", title: `Invite link for ${res.invite.email}`, link: res.link, email: res.email });
      },
    });
  };

  const restoreInviteFocus = () => {
    const button = inviteButtonRef.current;
    return button && !button.disabled ? button : inviteEmailInputRef.current;
  };

  const restoreSetPasswordFocus = () => {
    const button = setPasswordOpenerRef.current;
    return button && !button.disabled ? button : null;
  };

  const pendingInvites = invites.data ?? [];

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Members</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Everyone with an account in this workspace. Workspace membership is the base grant — team membership and project access build on it. Deactivating blocks sign-in (session invalidated); deleting removes the account and revokes its API keys.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 90 }}>Role</th><th style={{ width: "auto" }}>Teams</th><th style={{ width: "auto" }}>Last seen</th><th style={{ width: "auto" }} /></tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === currentUserId;
                const deactivated = !!(m as WorkspaceMember & { deactivated?: boolean }).deactivated;
                const teamsLabel = m.teams?.length ? m.teams.map((t) => t.teamName).join(", ") : "—";
                return (
                  <tr key={m.id} style={deactivated ? { opacity: 0.6 } : undefined}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="avatar" style={deactivated ? { opacity: 0.5 } : undefined}>{m.name?.[0]?.toUpperCase() ?? "?"}</div>
                        <span className="text-sm font-medium" style={deactivated ? { color: "var(--lx-text-muted)" } : undefined}>{m.name}</span>
                      </div>
                    </td>
                    <td className="text-xs text-lx-text-secondary" style={{ overflowWrap: "anywhere" }}>{m.email}</td>
                    <td className="text-xs">
                      {m.role === "superadmin" ? (
                        <span style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>superadmin</span>
                      ) : deactivated ? (
                        <span style={{ background: "var(--lx-bg-danger-subtle)", color: "var(--lx-text-danger)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>deactivated</span>
                      ) : (
                        <span style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 11 }}>member</span>
                      )}
                    </td>
                    <td className="text-xs text-lx-text-secondary">{teamsLabel}</td>
                    <td className="text-xs text-lx-text-secondary">{m.lastSeen ? formatRelative(m.lastSeen) : <span className="text-lx-text-muted">never</span>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {m.role === "superadmin" ? (
                        <span className="text-xs text-lx-text-muted">Set by your server admin</span>
                      ) : (
                        <>
                          <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} title="Send set-password link" onClick={(event) => handleSetPassword(m, event.currentTarget)} disabled={setPasswordLink.isPending && setPasswordLink.variables === m.id}>Set password</button>
                          {deactivated ? (
                            <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} title="Reactivate" onClick={() => updateMember.mutate({ userId: m.id, action: "reactivate" })}>Reactivate</button>
                          ) : (
                            <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} title="Deactivate" onClick={() => updateMember.mutate({ userId: m.id, action: "deactivate" })} disabled={isSelf}>Deactivate</button>
                          )}
                          <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} aria-label={`Delete member ${m.name}`} onClick={() => setDeleting(m)} disabled={isSelf}><Trash2 size={14} strokeWidth={1.5} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Invites */}
      <div className="card-panel card-panel--elevated mt-4">
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Invites</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            ref={inviteEmailInputRef}
            className="prop-input"
            placeholder="Invite by email (e.g. nova@example.com)"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={{ minWidth: 280 }}
            aria-label="Invite email"
          />
          <button ref={inviteButtonRef} type="button" className="btn btn-primary" onClick={handleInvite} disabled={!inviteEmail.trim() || createInvite.isPending}>
            <Plus size={14} strokeWidth={1.5} />
            Send invite
          </button>
        </div>
        <div className="field-hint" style={{ marginTop: 8 }}>Creates a single-use invite link (7-day expiry). When email is configured, the invite is emailed to this address; the link stays available to copy and share.</div>

        {pendingInvites.length > 0 && (
          <div className="card-panel" style={{ overflow: "hidden", marginTop: 12 }}>
            <table className="settings-table">
              <thead>
                <tr><th style={{ width: "auto" }}>Email</th><th style={{ width: "auto" }}>Link hint</th><th style={{ width: "auto" }}>Expires</th><th style={{ width: 80 }} /></tr>
              </thead>
              <tbody>
                {pendingInvites.map((i: WorkspaceInvite) => (
                  <tr key={i.id}>
                    <td className="text-sm font-medium" style={{ overflowWrap: "anywhere" }}>{i.email}</td>
                    <td className="font-mono text-xs text-lx-text-muted">{i.tokenHint ? `lx-…${i.tokenHint}` : "—"}</td>
                    <td className="text-xs text-lx-text-secondary">{i.expiresAt ? EXPIRY_FMT.format(parseApiDate(i.expiresAt)) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => revokeInvite.mutate(i.id)} disabled={revokeInvite.isPending && revokeInvite.variables === i.id}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleting && (
        <MemberDeleteModal
          name={deleting.name}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteMember.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
          }}
        />
      )}
      {linkModal && <LinkCopyModal title={linkModal.title} link={linkModal.link} email={linkModal.email} onDone={() => setLinkModal(null)} restoreFocus={linkModal.kind === "invite" ? restoreInviteFocus : restoreSetPasswordFocus} />}
    </section>
  );
}

function MemberDeleteModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Delete member?"
      body={<>Delete{" "}<span className="chip font-mono text-xs text-lx-text-primary">{name}</span>{" "}from the workspace? Their API keys are revoked and team memberships and project grants are cleared. Activity and comments keep their rows. This cannot be undone.</>}
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function TeamsSection() {
  const { data: teams = [], isLoading } = useTeams();
  const { data: members = [] } = useWorkspaceMembers();
  const { data: projects = [] } = useProjects();
  const createTeam = useCreateTeam();
  const deleteTeam = useDeleteTeam();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const memberCountByTeam = (teamId: string) => members.filter((m) => m.teams?.some((t) => t.teamId === teamId)).length;
  const projectCountByTeam = (teamId: string) => projects.filter((p) => (p as Project & { teamId?: string | null }).teamId === teamId).length;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Teams</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Teams group members and projects. Every project belongs to exactly one team (or none — "Global"). Team admins manage their own team from /settings/team.
      </p>

      <div className="card-panel card-panel--elevated" style={{ marginBottom: 12 }}>
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Create team</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Name" htmlFor="team-name" className="field mb-0">
            <TextInput id="team-name" placeholder="Platform" value={name} onChange={setName} style={{ minWidth: 200 }} />
          </Field>
          <Field label="Slug" htmlFor="team-slug" className="field mb-0">
            <TextInput id="team-slug" className="font-mono" placeholder="platform" value={slug} onChange={setSlug} style={{ minWidth: 160 }} />
          </Field>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim() || createTeam.isPending}
            onClick={() => createTeam.mutate({ name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}) }, { onSuccess: () => { setName(""); setSlug(""); } })}
          >
            Create team
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Team</th><th>Members</th><th>Projects</th><th>Created</th><th /></tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Users size={14} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />
                      <span className="text-sm font-medium">{t.name}</span>
                      <span className="font-mono text-xs text-lx-text-muted">{t.slug}</span>
                    </div>
                  </td>
                  <td className="text-xs text-lx-text-secondary">{memberCountByTeam(t.id)}</td>
                  <td className="text-xs text-lx-text-secondary">{projectCountByTeam(t.id)}</td>
                  <td className="text-xs text-lx-text-secondary">{t.createdAt?.slice(0, 10) ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} aria-label={`Delete team ${t.name}`} onClick={() => setDeleting({ id: t.id, name: t.name })}><Trash2 size={14} strokeWidth={1.5} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleting && (
        <TeamDeleteModal
          name={deleting.name}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deleteTeam.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
          }}
        />
      )}
    </section>
  );
}

function TeamDeleteModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title="Delete team?"
      body={<>Delete{" "}<span className="chip font-mono text-xs text-lx-text-primary">{name}</span>{" "}? Move or delete its projects first — without a team, they become Global. Memberships are removed.</>}
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

// Runtime Agents & Skills (workspace-global rule bundles; full editor inline).
function AgentsSkillsSections() {
  return (
    <>
      <AgentsSettingsSection />
      <SkillsSettingsSection />
    </>
  );
}

export type WorkspaceTab = "members" | "teams" | "access" | "integrations";

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "members", label: "Members" },
  { id: "teams", label: "Teams" },
  { id: "access", label: "Access" },
  { id: "integrations", label: "Integrations" },
];

export function WorkspaceSettings({ initialTab, githubResult }: { initialTab?: WorkspaceTab | undefined; githubResult?: GithubReturnResult | undefined } = {}) {
  const { data: session } = useSession();
  const isSuperadmin = session?.user?.role === "superadmin";
  const [tab, setTab] = useState<WorkspaceTab>(initialTab ?? "members");

  // The callback lands with ?tab=integrations — keep local tab state in sync
  // with search-driven changes without making every tab click a navigation.
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  return (
    <main className="page-frame page-frame-narrow">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-4">Workspace settings</h1>
      <p className="text-sm text-lx-text-secondary mb-6" style={{ maxWidth: 560 }}>
        Superadmin-only surface. Members, invites, teams, API keys, rate limiting, GitHub sync, Assistant providers, agents &amp; skills. Admins are configured on the server, not from the app.
      </p>
      {isSuperadmin && (
        <div className="card-panel mt-0 mb-6" style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span className="text-sm text-lx-text-secondary">Gateway usage, cost, latency &amp; health — all projects aggregated.</span>
          <Link to="/admin/assistant/usage" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
            Assistant Usage · Gateway
          </Link>
        </div>
      )}

      <div className="ms-tabs" role="tablist" aria-label="Workspace settings sections">
        {WORKSPACE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "ms-tab active" : "ms-tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "members" && <WorkspaceMembersSection />}
      {tab === "teams" && <TeamsSection />}
      {tab === "access" && (
        <>
          <ApiKeysSection />
          <RateLimitSection />
        </>
      )}
      {tab === "integrations" && (
        <>
          <GithubSyncSection githubResult={githubResult} />
          {isSuperadmin && <AssistantProvidersSection />}
          {isSuperadmin && <AssistantMcpSection />}
          <AgentsSkillsSections />
        </>
      )}
    </main>
  );
}