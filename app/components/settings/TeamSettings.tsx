import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useSession, useTeams, useTeamMembers, useAddTeamMember, useUpdateTeamMemberRole, useRemoveTeamMember, useTeamRuntimes, useWorkspaceMembers, useProjects } from "../../lib/queries";
import { InlineDropdown } from "./SettingsSections";
import { useTeamSelection } from "../../lib/team-selection";
import { TeamSettingsRuntimesTable } from "./TeamRuntimesTable";
import type { Team, TeamMember, TeamMemberRole, Project } from "../../../shared/types";
import type { WorkspaceMember } from "../../lib/api";

const ROLES: TeamMemberRole[] = ["owner", "admin", "member"];

// /settings/team — team admin: own team only (no switcher) · superadmin: any
// team (header switcher). The server enforces both paths.
export function TeamSettings() {
  const { data: session } = useSession();
  const { data: teams = [], isLoading: teamsLoading } = useTeams();
  const { activeTeamId, setActiveTeamId } = useTeamSelection();
  const isSuperadmin = session?.user?.role === "superadmin";

  const team: Team | undefined = isSuperadmin
    ? teams.find((t) => t.id === activeTeamId) ?? teams[0]
    : teams[0];

  // Keep the persisted selection in sync with the first team for team admins
  // (their team is fixed) and with the resolved team for superadmins.
  useEffect(() => {
    if (team && (!activeTeamId || (isSuperadmin && team.id !== activeTeamId))) {
      setActiveTeamId(team.id);
    }
  }, [team, activeTeamId, isSuperadmin, setActiveTeamId]);

  if (teamsLoading) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="skeleton" style={{ width: 220, height: 28 }} />
        <div className="skeleton mt-3" style={{ width: 120, height: 14 }} />
      </main>
    );
  }

  if (!team) {
    return (
      <main className="page-frame page-frame-narrow">
        <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-4">Team settings</h1>
        <div className="empty-box">
          <div className="text-sm font-medium text-lx-text-primary">No team</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
            You don't administer a team yet. Ask a workspace superadmin to create one and add you to it.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="page-frame page-frame-narrow">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-0">Team settings</h1>
        {isSuperadmin && teams.length > 1 && (
          <TeamSwitcher teams={teams} activeTeamId={team.id} onSelect={setActiveTeamId} />
        )}
      </div>

      <TeamProfileSection team={team} />
      <TeamMembersSection teamId={team.id} isSuperadmin={isSuperadmin} />
      <TeamProjectsSection teamId={team.id} />
      <TeamRuntimesSection teamId={team.id} />
    </main>
  );
}

function TeamSwitcher({ teams, activeTeamId, onSelect }: { teams: Team[]; activeTeamId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = teams.find((t) => t.id === activeTeamId) ?? teams[0];

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="nav-pill" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="weight-500" style={{ fontWeight: 500 }}>{active?.name ?? "Select team"}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220, zIndex: 60 }} role="menu">
          <div className="dropdown-label">Teams</div>
          {teams.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === activeTeamId ? "dropdown-item active" : "dropdown-item"}
              style={{ gap: 8, width: "100%", textAlign: "left", border: "none", background: "none", font: "inherit", padding: "0 10px", cursor: "pointer", height: 32 }}
              onClick={() => { onSelect(t.id); setOpen(false); }}
            >
              <span className="text-sm">{t.name}</span>
              <span className="font-mono text-xs text-lx-text-muted">{t.slug}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Team profile: name editable, slug read-only (no rename endpoint).
function TeamProfileSection({ team }: { team: Team }) {
  const [name, setName] = useState(team.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${team.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as Team;
      setName(updated.name ?? trimmed);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Profile</h2>
      <div className="card-panel card-panel--elevated mt-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="team-profile-name">Name</label>
            <input id="team-profile-name" className="prop-input" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} style={{ minWidth: 220 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="team-profile-slug">Slug</label>
            <div className="flex items-center gap-2">
              <input id="team-profile-slug" className="prop-input font-mono" value={team.slug} disabled style={{ minWidth: 160 }} />
              <span className="text-xs text-lx-text-muted">read-only</span>
            </div>
          </div>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {error && <div className="field-hint-danger mt-2">{error}</div>}
        {saved && !error && <div className="field-hint mt-2" style={{ color: "var(--lx-text-success)" }}>Saved.</div>}
      </div>
    </section>
  );
}

// Members: add by email over existing workspace members; role owner/admin/
// member; remove with SOLE_OWNER guard.
function TeamMembersSection({ teamId, isSuperadmin }: { teamId: string; isSuperadmin: boolean }) {
  const { data: members = [], isLoading } = useTeamMembers(teamId);
  const addMember = useAddTeamMember(teamId);
  const updateRole = useUpdateTeamMemberRole(teamId);
  const removeMember = useRemoveTeamMember(teamId);
  // Superadmins get a real type-ahead over the workspace member list; team
  // admins type an email and the server 422s with details.available* if it
  // isn't a workspace member.
  const { data: workspaceMembers } = useWorkspaceMembers();
  const [query, setQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [role, setRole] = useState<TeamMemberRole>("member");
  const [adding, setAdding] = useState<string | null>(null);

  const ownerCount = members.filter((m) => m.role === "owner").length;
  const suggestions = (workspaceMembers ?? []).filter(
    (u: WorkspaceMember) => !members.some((m) => m.userId === u.id) && (u.email.includes(query) || u.name.toLowerCase().includes(query.toLowerCase()))
  );

  const submitAdd = (email: string) => {
    setAdding(email);
    addMember.mutate({ email, role }, {
      onSuccess: () => { setQuery(""); setShowDropdown(false); setAdding(null); },
      onError: () => setAdding(null),
    });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Members</h2>
        <span className="text-xs text-lx-text-muted">Team scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Team roles: owner (full control) · admin (manage members + runtimes) · member (uses the team's projects and runtimes). Only existing workspace members can be added — invites to new people happen at Workspace settings.
      </p>

      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div style={{ position: "relative", minWidth: 280, flexShrink: 0 }}>
          <div className="flex items-center gap-2">
            <input
              className="prop-input"
              placeholder="Add member by email..."
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
              onFocus={() => setShowDropdown(true)}
              style={{ width: "100%" }}
              aria-label="Add member by email"
            />
            <select className="prop-input" value={role} onChange={(e) => setRole(e.target.value as TeamMemberRole)} aria-label="Role" style={{ height: 32, fontSize: 12, width: 96, flexShrink: 0 }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="btn btn-primary" style={{ height: 32, padding: "0 12px", fontSize: 12, flexShrink: 0 }} disabled={!query.trim() || addMember.isPending} onClick={() => submitAdd(query.trim())}>
              <Plus size={14} strokeWidth={1.5} />
              Add
            </button>
          </div>
          {isSuperadmin && showDropdown && (
            <InlineDropdown
              items={suggestions.map((u) => ({ name: u.name, email: u.email }))}
              onSelect={submitAdd}
              onClose={() => setShowDropdown(false)}
            />
          )}
          <span className="text-xs text-lx-text-muted" style={{ display: "block", marginTop: 4 }}>
            {isSuperadmin ? "Type-ahead over existing workspace members." : "Existing workspace members only — unknown emails error with an available list."}
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 120 }}>Role</th><th style={{ width: 80 }} /></tr>
            </thead>
            <tbody>
              {members.map((m: TeamMember) => {
                const soleOwner = ownerCount === 1 && m.role === "owner";
                return (
                  <tr key={m.userId} style={adding === m.email ? { background: "var(--lx-bg-accent-subtle)" } : undefined}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="avatar">{m.name?.[0]?.toUpperCase() ?? "?"}</div>
                        <span className="text-sm font-medium">{m.name}</span>
                      </div>
                    </td>
                    <td className="text-xs text-lx-text-secondary">{m.email}</td>
                    <td className="text-xs">
                      <select
                        className="prop-input"
                        value={m.role}
                        disabled={soleOwner}
                        title={soleOwner ? "Sole owner — cannot be demoted" : undefined}
                        onChange={(e) => updateRole.mutate({ userId: m.userId, role: e.target.value as TeamMemberRole })}
                        style={{ height: 28, fontSize: 12, padding: "0 24px 0 8px", width: "100%" }}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-danger"
                        style={{ width: 28, height: 28, padding: 0, fontSize: 12 }}
                        disabled={soleOwner}
                        title={soleOwner ? "Sole owner — cannot be removed" : "Remove member"}
                        aria-label={`Remove ${m.name}`}
                        onClick={() => removeMember.mutate(m.userId)}
                      >
                        <Trash2 size={14} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Projects: read-only list of this team's projects (unassigned = Global).
function TeamProjectsSection({ teamId }: { teamId: string }) {
  const { data: projects = [] } = useProjects();
  const teamProjects = projects.filter((p) => (p as Project & { teamId?: string | null }).teamId === teamId);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Projects</h2>
        <span className="text-xs text-lx-text-muted">Read-only</span>
      </div>
      <div className="card-panel" style={{ overflow: "hidden" }}>
        <table className="settings-table">
          <thead>
            <tr><th>Project</th><th>Slug</th></tr>
          </thead>
          <tbody>
            {teamProjects.length === 0 ? (
              <tr><td colSpan={2} className="text-xs text-lx-text-muted text-center py-6">No projects in this team yet. Assignment happens in project settings (project switcher → Project settings → team control).</td></tr>
            ) : (
              teamProjects.map((p) => (
                <tr key={p.id}>
                  <td><Link to="/$slug" params={{ slug: p.slug }} className="text-sm font-medium" style={{ color: "var(--lx-text-link)", textDecoration: "none" }}>{p.name}</Link></td>
                  <td className="font-mono text-xs text-lx-text-secondary">{p.slug}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Runtimes: the team's own runtimes only; Global section is superadmin-only
// (workspace page).
function TeamRuntimesSection({ teamId }: { teamId: string }) {
  const { data: runtimes = [], isLoading, isError } = useTeamRuntimes(teamId);
  return <TeamSettingsRuntimesTable teamId={teamId} runtimes={runtimes} isLoading={isLoading} isError={isError} />;
}
