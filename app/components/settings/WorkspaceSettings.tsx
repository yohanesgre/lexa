import { useState } from "react";
import { Check, Copy, Plus, Trash2, Users } from "lucide-react";
import { useSession, useWorkspaceMembers, useUpdateWorkspaceMember, useDeleteWorkspaceMember, useWorkspaceInvites, useCreateWorkspaceInvite, useRevokeWorkspaceInvite, useCreateSetPasswordLink, useTeams, useCreateTeam, useDeleteTeam } from "../../lib/queries";
import { ApiKeysSection, GithubSyncSection, MachinesRuntimesSection, RateLimitSection, formatRelative } from "./SettingsSections";
import { AgentsSettingsSection, SkillsSettingsSection } from "../forge/AgentSkillSettings";
import { copyToClipboard } from "../../lib/clipboard";
import type { WorkspaceInvite } from "../../../shared/types";
import type { WorkspaceMember } from "../../lib/api";

// Superadmin-only workspace settings: Members + invites, Teams, Machines &
// runtimes, API keys, rate limiting, GitHub sync, Forge agents & skills.
// NO Superadmins section — superadmin is env-only (LXK_ADMIN_EMAILS).

function LinkCopyModal({ title, link, onDone }: { title: string; link: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const ok = await copyToClipboard(link);
    setCopied(ok);
  };
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onDone} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label={title} style={{ maxWidth: 460, width: "calc(100vw - 48px)" }}>
          <h2 className="font-display text-lg font-medium text-lx-text-primary">{title}</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Share this link out-of-band (no email transport is configured). Single-use, expires after 7 days.
          </p>
          <div className="key-display mt-3">
            <code>{link}</code>
          </div>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onDone}>Close</button>
            <button type="button" className="btn btn-primary" onClick={handleCopy}>
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
  const [linkModal, setLinkModal] = useState<{ title: string; link: string } | null>(null);

  const currentUserId = session?.session?.userId;

  const handleSetPassword = (m: WorkspaceMember) => {
    setPasswordLink.mutate(m.id, {
      onSuccess: (res) => setLinkModal({ title: `Set-password link for ${m.email}`, link: res.link }),
    });
  };

  const handleInvite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    createInvite.mutate(email, {
      onSuccess: (res) => {
        setInviteEmail("");
        setLinkModal({ title: `Invite link for ${email}`, link: res.link });
      },
    });
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
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
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
                    <td className="text-xs text-lx-text-secondary">{m.email}</td>
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
                        <span className="text-xs text-lx-text-muted">env-provisioned — no row actions</span>
                      ) : (
                        <>
                          <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px", fontSize: 12 }} title="Send set-password link" onClick={() => handleSetPassword(m)}>Set password</button>
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
      <div className="mt-4 p-4" style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8 }}>
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Invites</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="prop-input"
            placeholder="Invite by email (e.g. nova@emberfall.dev)"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            style={{ minWidth: 280 }}
            aria-label="Invite email"
          />
          <button type="button" className="btn btn-primary" onClick={handleInvite} disabled={!inviteEmail.trim() || createInvite.isPending}>
            <Plus size={14} strokeWidth={1.5} />
            Send invite
          </button>
        </div>
        <div className="field-hint" style={{ marginTop: 8 }}>Creates a single-use invite link (7-day expiry) delivered out-of-band — no SMTP is configured. Accepting opens /invite → member account.</div>

        {pendingInvites.length > 0 && (
          <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden", marginTop: 12 }}>
            <table className="settings-table">
              <thead>
                <tr><th style={{ width: "auto" }}>Email</th><th style={{ width: "auto" }}>Link hint</th><th style={{ width: "auto" }}>Expires</th><th style={{ width: 80 }} /></tr>
              </thead>
              <tbody>
                {pendingInvites.map((i: WorkspaceInvite) => (
                  <tr key={i.id}>
                    <td className="text-sm font-medium">{i.email}</td>
                    <td className="font-mono text-xs text-lx-text-muted">{i.tokenHint ? `lx-…${i.tokenHint}` : "—"}</td>
                    <td className="text-xs text-lx-text-secondary">{i.expiresAt ? formatRelative(i.expiresAt) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <button type="button" className="btn btn-danger" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => revokeInvite.mutate(i.id)}>
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
      {linkModal && <LinkCopyModal title={linkModal.title} link={linkModal.link} onDone={() => setLinkModal(null)} />}
    </section>
  );
}

function MemberDeleteModal({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete member?</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Delete{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}from the workspace? Their API keys are revoked and team memberships and project grants are cleared. Activity and comments keep their rows. This cannot be undone.
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

function TeamsSection() {
  const { data: teams = [], isLoading } = useTeams();
  const { data: members = [] } = useWorkspaceMembers();
  const createTeam = useCreateTeam();
  const deleteTeam = useDeleteTeam();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const memberCountByTeam = (teamId: string) => members.filter((m) => m.teams?.some((t) => t.teamId === teamId)).length;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Teams</h2>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Teams group members, projects, and runtimes. Every project and runtime belongs to exactly one team (or none — "Global"). Team admins manage their own team from /settings/team.
      </p>

      <div className="p-4" style={{ background: "var(--lx-surface-elevated)", border: "1px solid var(--lx-border-default)", borderRadius: 8, marginBottom: 12 }}>
        <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Create team</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="team-name">Name</label>
            <input id="team-name" className="prop-input" placeholder="Platform" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 200 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="team-slug">Slug</label>
            <input id="team-slug" className="prop-input font-mono" placeholder="platform" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ minWidth: 160 }} />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!name.trim() || createTeam.isPending}
            onClick={() => createTeam.mutate({ name: name.trim(), slug: slug.trim() || undefined }, { onSuccess: () => { setName(""); setSlug(""); } })}
          >
            Create team
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Team</th><th>Members</th><th>Created</th><th /></tr>
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
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete team?</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Delete{" "}
            <span className="font-mono text-xs text-lx-text-primary" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px" }}>
              {name}
            </span>
            {" "}? Teams owning projects are refused with 409 TEAM_HAS_PROJECTS — re-assign or delete those projects first. Memberships are removed; projects become Global.
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

// Forge Agents & Skills (workspace-global rule bundles; full editor inline).
function AgentsSkillsSections() {
  return (
    <>
      <AgentsSettingsSection />
      <SkillsSettingsSection />
    </>
  );
}

export function WorkspaceSettings() {
  return (
    <main className="page-frame page-frame-narrow">
      <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-4">Workspace settings</h1>
      <p className="text-sm text-lx-text-secondary mb-6" style={{ maxWidth: 560 }}>
        Superadmin-only surface. Members, invites, teams, machines &amp; runtimes, API keys, rate limiting, GitHub sync, Forge agents &amp; skills. Superadmin is env-provisioned (LXK_ADMIN_EMAILS) — there is no in-app promotion UI.
      </p>

      <WorkspaceMembersSection />
      <TeamsSection />
      <MachinesRuntimesSection showTeamColumn />
      <ApiKeysSection />
      <RateLimitSection />
      <GithubSyncSection />
      <AgentsSkillsSections />
    </main>
  );
}
