import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Trash2, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useProjects, useProjectMembers, useAddProjectMember, useRemoveProjectMember, useDeleteProject, useUpdateProject, useProjectRepos, useReplaceProjectRepos, useGithubRepoSearch, useUsers, useTeams, useUpdateProjectTeam, useSession } from "../../lib/queries";
import * as api from "../../lib/api";
import { InlineDropdown } from "./SettingsSections";
import { HeraldProviderSection, ProjectMemorySection } from "./HeraldSettingsSection";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/TextInput";
import { TextArea } from "../ui/TextArea";
import type { Project } from "../../../shared/types";

// /settings/project/$projectId — the project settings surface reached from
// the project switcher ("Project settings"). Gates: project name/desc/repo
// edit + team assignment (PATCH /api/projects/:projectId/team — superadmin
// any team, team admin own team; the server enforces).

export function ProjectSettingsHub({ projectId }: { projectId: string }) {
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  if (projectsLoading) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="skeleton" style={{ width: 240, height: 28 }} />
        <div className="skeleton mt-3" style={{ width: 140, height: 14 }} />
      </main>
    );
  }

  if (!project) {
    return (
      <main className="page-frame page-frame-narrow">
        <div className="empty-box">
          <div className="text-sm font-medium text-lx-text-primary">Project not found</div>
          <p className="text-xs text-lx-text-secondary">It may have been deleted or you don't have access.</p>
          <Link to="/" className="btn btn-primary mt-3" style={{ height: 32, padding: "0 14px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Back to projects</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page-frame page-frame-narrow">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-lx-text-primary mb-0">Project settings</h1>
          <p className="text-sm text-lx-text-secondary mt-1">{project.name} · <span className="font-mono text-xs">{project.slug}</span></p>
        </div>
        <Link to="/$slug" params={{ slug: project.slug }} className="btn btn-ghost" style={{ height: 32, padding: "0 14px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
          Open dashboard
        </Link>
      </div>

      <TeamAssignmentSection project={project} />
      <ProjectBasicSection project={project} />
      <HeraldProviderSection project={project} />
      <ProjectMemorySection projectId={project.id} />
      <LinkedReposSection slug={project.slug} />
      <ProjectMembersSection slug={project.slug} />
      <ProjectDangerSection project={project} />
    </main>
  );
}

// Team assignment — the project's owning team (or Global). Superadmin any
// team; team admin own team (the server enforces; the FE only offers the
// teams the caller can see).
function TeamAssignmentSection({ project }: { project: Project }) {
  const { data: teams = [], isLoading } = useTeams();
  const updateTeam = useUpdateProjectTeam();
  const { data: session } = useSession();
  const isSuperadmin = session?.user?.role === "superadmin";
  const currentTeamId = (project as Project & { teamId?: string | null }).teamId ?? null;

  if (isLoading) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Team</h2>
        <span className="text-xs text-lx-text-muted">Team assignment</span>
      </div>
      <div className="card-panel card-panel--elevated mt-4">
        <p className="text-sm text-lx-text-secondary mb-3" style={{ marginTop: 0 }}>
          The owning team scopes Forge claims: a task can only run on a runtime of the same team (Global runtimes accept any team). Unassigned projects are Global.
          {!isSuperadmin && " As a team admin you can assign this project to your own team only."}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            className="prop-input"
            value={currentTeamId ?? ""}
            onChange={(e) => updateTeam.mutate({ projectId: project.id, teamId: e.target.value ? e.target.value : null })}
            aria-label="Project team"
            style={{ minWidth: 200 }}
          >
            <option value="">Global (no team)</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>
            ))}
          </select>
          <span className="text-xs text-lx-text-muted">Saved immediately on change.</span>
        </div>
      </div>
    </section>
  );
}

// Name + description edit (same shape as the old modal-in-dashboard).
function ProjectBasicSection({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
  }, [project.name, project.description]);

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Project</h2>
      <div className="card-panel card-panel--elevated mt-4">
        <Field label="Name" htmlFor="project-name" hint="Shown on the dashboard and in the nav. Slug is fixed." className="field mb-3">
          <TextInput id="project-name" value={name} onChange={(v) => { setName(v); setSaved(false); }} />
        </Field>
        <Field label="Description" htmlFor="project-desc" className="field">
          <TextArea id="project-desc" value={description} onChange={(v) => { setDescription(v); setSaved(false); }} />
        </Field>
        <div className="flex justify-end mt-4">
          <button
            type="button"
            className="btn btn-primary"
            disabled={updateProject.isPending || (!name.trim() || (name === project.name && description === (project.description ?? "")))}
            onClick={() =>
              updateProject.mutate(
                { slug: project.slug, name: name.trim(), description: description.trim() },
                { onSuccess: () => setSaved(true) }
              )
            }
          >
            {updateProject.isPending ? "Saving…" : "Save"}
          </button>
        </div>
        {saved && <div className="field-hint" style={{ color: "var(--lx-text-success)" }}>Saved.</div>}
      </div>
    </section>
  );
}

// Linked Repos — full-replace PUT via useReplaceProjectRepos. The typeahead
// shows repos already linked elsewhere in the workspace (from useProjects —
// every project payload carries its repos[]) plus GitHub App search results.
// Selecting a suggestion links the repo to this project immediately.
function LinkedReposSection({ slug }: { slug: string }) {
  const { data: repos = [], isLoading } = useProjectRepos(slug);
  const { data: projects = [] } = useProjects();
  const replaceRepos = useReplaceProjectRepos();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [removingRepo, setRemovingRepo] = useState<string | null>(null);
  const [removingAll, setRemovingAll] = useState(false);
  const search = useGithubRepoSearch(query);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Repos already linked to ANY project in the workspace (deduped, excluding
  // this project's own current list).
  const workspaceRepos = useMemo(() => {
    const linked = new Set<string>();
    for (const p of projects) {
      for (const r of p.repos ?? []) linked.add(r.repo);
    }
    return [...linked].sort();
  }, [projects]);

  const alreadyLinked = useMemo(() => new Set(repos.map((r) => r.repo)), [repos]);

  // Workspace-linked suggestions matching the query (or all when empty).
  const workspaceSuggestions = useMemo(
    () => workspaceRepos.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()) && !alreadyLinked.has(name)),
    [workspaceRepos, query, alreadyLinked]
  );

  // GitHub App search results (query >= 2 chars), excluding already-linked.
  const githubResults = (search.data ?? []).filter((name) => !alreadyLinked.has(name));

  const suggestionSet = useMemo(() => new Set(workspaceSuggestions), [workspaceSuggestions]);
  const suggestions = [...workspaceSuggestions, ...githubResults.filter((n) => !suggestionSet.has(n))];

  // Reset the dropdown highlight when the suggestion list length changes —
  // adjusted during render (React docs pattern), not in an effect.
  const [prevLen, setPrevLen] = useState(suggestions.length);
  if (prevLen !== suggestions.length) {
    setPrevLen(suggestions.length);
    setHighlight(0);
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) { if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const addRepo = (name: string) => {
    if (!name) return;
    const next = repos.some((r) => r.repo === name)
      ? repos.map((r) => (r.repo === name ? { ...r, workspaceRole: true } : r))
      : [...repos, { repo: name, sourceRole: false, workspaceRole: true }];
    replaceRepos.mutate({ slug, repos: next });
    setQuery("");
    setDropdownOpen(false);
  };

  const toggleRole = (repo: string, role: "sourceRole" | "workspaceRole") => {
    replaceRepos.mutate({ slug, repos: repos.map((r) => (r.repo === repo ? { ...r, [role]: !r[role] } : r)) });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Linked Repos</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Repos this project can read (source — Forge agent context) and sync issues with (workspace — linking, creating, and two-way state/content sync). Repos must be accessible to the installed GitHub App; the type-ahead shows repos already linked in the workspace plus GitHub App search results.
      </p>

      <div style={{ position: "relative", maxWidth: 420, marginBottom: 16 }} ref={dropdownRef}>
        <input
          className="prop-input"
          placeholder="Type a repo name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setDropdownOpen(true); }}
          onFocus={() => setDropdownOpen(true)}
          onKeyDown={(e) => {
            if (!dropdownOpen || suggestions.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); }
            if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); }
            if (e.key === "Enter") { e.preventDefault(); const item = suggestions[highlight]; if (item) addRepo(item); }
          }}
          style={{ width: "100%" }}
          aria-label="Search GitHub repos"
        />
        {dropdownOpen && (suggestions.length > 0 || workspaceSuggestions.length > 0) && (
          <div className="dropdown-menu" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 10, width: "100%" }}>
            {workspaceSuggestions.length > 0 && (
              <>
                <div className="dropdown-label">Linked in workspace</div>
                {workspaceSuggestions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="dropdown-item w-full text-left"
                    style={name === suggestions[highlight] ? { background: "var(--lx-surface-card-hover)" } : undefined}
                    onMouseEnter={() => setHighlight(suggestions.indexOf(name))}
                    onClick={() => { addRepo(name); }}
                  >
                    <span className="font-mono text-xs">{name}</span>
                  </button>
                ))}
              </>
            )}
            {githubResults.length > 0 && (
              <>
                <div className="dropdown-label">GitHub repos</div>
                {githubResults.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="dropdown-item w-full text-left"
                    style={name === suggestions[highlight] ? { background: "var(--lx-surface-card-hover)" } : undefined}
                    onMouseEnter={() => setHighlight(suggestions.indexOf(name))}
                    onClick={() => { addRepo(name); }}
                  >
                    <span className="font-mono text-xs">{name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : repos.length === 0 ? (
        <div className="empty-box mb-4">
          <div className="text-sm font-medium text-lx-text-primary">No linked repos</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>Link a repo to let Forge read it and to sync issues with the board.</p>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Repository</th><th>Source</th><th>Workspace</th><th style={{ width: 80 }} /></tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.repo}>
                  <td className="font-mono text-xs">{r.repo}</td>
                  <td>
                    <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>
                      <input type="checkbox" checked={r.sourceRole} onChange={() => toggleRole(r.repo, "sourceRole")} />
                      Source
                    </label>
                  </td>
                  <td>
                    <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>
                      <input type="checkbox" checked={r.workspaceRole} onChange={() => toggleRole(r.repo, "workspaceRole")} />
                      Workspace
                    </label>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="btn btn-ghost h-7 px-2 text-xs text-lx-text-danger" aria-label={`Remove ${r.repo}`} onClick={() => setRemovingRepo(r.repo)}>
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {repos.length > 1 && (
        <button type="button" className="btn btn-ghost text-xs mt-2" style={{ height: 28, padding: "0 10px", color: "var(--lx-text-danger)" }} onClick={() => setRemovingAll(true)}>
          Remove all repos
        </button>
      )}

      {removingRepo && (
        <RemoveRepoModal
          repo={removingRepo}
          onCancel={() => setRemovingRepo(null)}
          onConfirm={() => {
            replaceRepos.mutate({ slug, repos: repos.filter((r) => r.repo !== removingRepo) });
            setRemovingRepo(null);
          }}
        />
      )}
      {removingAll && (
        <RemoveRepoModal
          onCancel={() => setRemovingAll(false)}
          onConfirm={() => {
            replaceRepos.mutate({ slug, repos: [] });
            setRemovingAll(false);
          }}
        />
      )}
    </section>
  );
}

function RemoveRepoModal({ repo, onCancel, onConfirm }: { repo?: string; onCancel: () => void; onConfirm: () => void }) {
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
                <span className="chip font-mono text-xs text-lx-text-primary">
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

// Project members — add/remove, sourced from the workspace user list.
function ProjectMembersSection({ slug }: { slug: string }) {
  const { data: members = [], isLoading } = useProjectMembers(slug);
  const { data: project } = useQuery({ queryKey: ["project", slug], queryFn: () => api.getProject(slug) });
  const { data: users = [] } = useUsers();
  const addMember = useAddProjectMember(slug);
  const removeMember = useRemoveProjectMember(slug);
  const [memberQuery, setMemberQuery] = useState("");
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const memberEmails = new Set(members.map((m) => m.email));
  const memberSuggestions = users.filter(
    (u) => !memberEmails.has(u.email) && (u.email.includes(memberQuery) || u.name.toLowerCase().includes(memberQuery.toLowerCase()))
  );

  const handleAdd = (email: string) => {
    const user = memberSuggestions.find((u) => u.email === email);
    if (user && project) addMember.mutate({ userId: user.id, projectId: project.id });
    setMemberQuery("");
    setShowMemberDropdown(false);
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Project Members</h2>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <p className="text-sm text-lx-text-secondary" style={{ maxWidth: 560, marginBottom: 0 }}>
          Manage which team members can access this project. Changes take effect immediately.
        </p>
        <div style={{ position: "relative", minWidth: 240, flexShrink: 0 }}>
          <input
            className="prop-input"
            aria-label="Add member"
            placeholder="Add member..."
            value={memberQuery}
            onChange={(e) => { setMemberQuery(e.target.value); setShowMemberDropdown(true); }}
            onFocus={() => setShowMemberDropdown(true)}
            style={{ width: "100%" }}
          />
          {showMemberDropdown && (
            <InlineDropdown
              items={memberSuggestions.map((u) => ({ name: u.name, email: u.email }))}
              onSelect={handleAdd}
              onClose={() => setShowMemberDropdown(false)}
            />
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading…</div>
      ) : members.length === 0 ? (
        <div className="empty-box mb-4">
          <Users size={20} strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }} />
          <div className="text-sm font-medium text-lx-text-primary">No members yet</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 300 }}>Add members below to grant them access.</p>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: "auto" }}>User</th><th style={{ width: "auto" }}>Email</th><th style={{ width: 80 }}>Role</th><th style={{ width: 80 }} /></tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email}>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="avatar">{m.name[0]?.toUpperCase() ?? "?"}</div>
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
      )}

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
    </section>
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
            <span className="chip font-mono text-xs text-lx-text-primary">
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

function ProjectDangerSection({ project }: { project: Project }) {
  const navigate = useNavigate();
  const deleteProject = useDeleteProject();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [input, setInput] = useState("");

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Delete project</h2>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Deleting a project removes all tasks, columns, swimlanes, wiki pages, and member assignments permanently.
      </p>
      <button type="button" className="btn btn-danger" style={{ height: 32, padding: "0 14px", fontSize: 12 }} onClick={() => setConfirmOpen(true)}>
        <Trash2 size={14} strokeWidth={1.5} />
        Delete project
      </button>

      {confirmOpen && (
        <>
          <button type="button" className="slideover-overlay" onClick={() => setConfirmOpen(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog" style={{ maxWidth: 420 }}>
              <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete project?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This permanently deletes{" "}
                <span className="chip font-mono text-xs text-lx-text-primary">
                  {project.name}
                </span>
                {" "}and all its tasks, columns, swimlanes, wiki pages, and member assignments. This action cannot be undone.
              </p>
              <label className="field-label mt-4" htmlFor="confirm-delete">Type <strong>{project.name}</strong> to confirm</label>
              <input
                id="confirm-delete"
                className="prop-input mt-1"
                placeholder={project.name}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                style={{ width: "100%" }}
              />
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  disabled={input !== project.name || deleteProject.isPending}
                  onClick={() => {
                    deleteProject.mutate(project.slug, {
                      onSuccess: () => navigate({ to: "/" }),
                    });
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete Project
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </section>
  );
}
