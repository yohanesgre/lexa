import { useState } from "react";
import { Plus, Settings, Trash2 } from "lucide-react";
import { cn } from "../ui/cn";
import { useForgeAgents, useForgeSkills } from "../../lib/queries";
import { PromptEditorModal } from "./PromptEditorModal";
import type { ForgeAgent, ForgeSkill } from "../../../shared/types";

function BuiltinBadge() {
  return (
    <span className="font-micro text-2xs uppercase tracking-[0.04em]" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 10 }}>
      builtin
    </span>
  );
}

function formatUpdated(iso: string): string {
  const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// Settings → Agents (global rule bundles). Each agent's instructions become
// AGENTS.md in the run dir at claim time; skills attach via M2M bindings.
export function AgentsSettingsSection() {
  const { data: agents = [], isLoading, isError } = useForgeAgents();
  const { data: skills = [] } = useForgeSkills();
  const [editing, setEditing] = useState<ForgeAgent | "new" | null>(null);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Agents</h2>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Global scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Named rule bundles sent to the runtime agent on every Forge run (as AGENTS.md). The agent's instructions define behavior; skills define what it can do. Not to be confused with a runtime's CLI agent — that's the CLI/Persona on the runtime row.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading agents…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load agents.</div>
      ) : agents.length === 0 ? (
        <div className="card-panel flex flex-col items-center gap-1.5 text-center mb-4" style={{ borderStyle: "dashed", borderColor: "var(--lx-border-strong)", padding: 24 }}>
          <div className="text-sm font-medium text-lx-text-primary mt-1">No agents yet</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
            Create one to tune what Forge sends to your runtimes. The builtin "Lexa" is seeded on a fresh install.
          </p>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12, marginTop: 8 }} onClick={() => setEditing("new")}>
            <Plus size={14} strokeWidth={1.5} />
            New agent
          </button>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Name</th><th>Description</th><th>Skills</th><th>Builtin</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td><span className="text-sm font-medium">{a.name}</span></td>
                  <td className="text-xs text-lx-text-secondary">{a.description || "—"}</td>
                  <td className="text-xs text-lx-text-secondary">{a.skillIds.length}</td>
                  <td>{a.isBuiltin ? <BuiltinBadge /> : <span className="text-xs text-lx-text-muted">—</span>}</td>
                  <td className="text-xs text-lx-text-secondary">{formatUpdated(a.updatedAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0, fontSize: 12 }} onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`} title="Edit agent">
                      <Settings size={14} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ width: 28, height: 28, padding: 0, fontSize: 12, opacity: a.isBuiltin ? 0.45 : 1 }}
                      disabled={a.isBuiltin}
                      onClick={() => setEditing(a)}
                      aria-label={a.isBuiltin ? "Builtin agents can't be deleted" : `Delete ${a.name}`}
                      title={a.isBuiltin ? "Builtin agents can't be deleted" : "Delete agent"}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !isError && agents.length > 0 && (
        <div className="mt-4" style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setEditing("new")}>
            <Plus size={14} strokeWidth={1.5} />
            New agent
          </button>
        </div>
      )}

      {editing !== null && (
        <PromptEditorModal
          kind="agent"
          entity={editing === "new" ? null : editing}
          allSkills={skills}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

// Settings → Skills (global operation bundles). Instructions become
// .agents/<skill>/SKILL.md at claim time; attachments are managed from the
// agent editor.
export function SkillsSettingsSection() {
  const { data: skills = [], isLoading, isError } = useForgeSkills();
  const { data: agents = [] } = useForgeAgents();
  const [editing, setEditing] = useState<ForgeSkill | "new" | null>(null);

  const usedBy = (skillId: string): string => {
    let names = "";
    for (const a of agents) {
      if (a.skillIds.includes(skillId)) names = names ? `${names} · ${a.name}` : a.name;
    }
    return names || "—";
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Skills</h2>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Global scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Named operation bundles attached to agents. On a Forge run the chosen skill's instructions become <span className="font-mono text-2xs">.agents/&lt;skill&gt;/SKILL.md</span> in the run dir. Builtins cover the original assistant actions.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading skills…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load skills.</div>
      ) : skills.length === 0 ? (
        <div className="card-panel flex flex-col items-center gap-1.5 text-center mb-4" style={{ borderStyle: "dashed", borderColor: "var(--lx-border-strong)", padding: 24 }}>
          <div className="text-sm font-medium text-lx-text-primary mt-1">No skills yet</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
            Create an operation bundle (continue, rewrite, summarize…) and attach it to an agent to make it available in the Forge popover.
          </p>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12, marginTop: 8 }} onClick={() => setEditing("new")}>
            <Plus size={14} strokeWidth={1.5} />
            New skill
          </button>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Name</th><th>Description</th><th>Used by</th><th>Builtin</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id}>
                  <td><span className="text-sm font-medium">{s.name}</span></td>
                  <td className="text-xs text-lx-text-secondary">{s.description || "—"}</td>
                  <td className="text-xs text-lx-text-secondary">{usedBy(s.id)}</td>
                  <td>{s.isBuiltin ? <BuiltinBadge /> : <span className="text-xs text-lx-text-muted">—</span>}</td>
                  <td className="text-xs text-lx-text-secondary">{formatUpdated(s.updatedAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0, fontSize: 12 }} onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`} title="Edit skill">
                      <Settings size={14} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ width: 28, height: 28, padding: 0, fontSize: 12, opacity: s.isBuiltin ? 0.45 : 1 }}
                      disabled={s.isBuiltin}
                      onClick={() => setEditing(s)}
                      aria-label={s.isBuiltin ? "Builtin skills can't be deleted" : `Delete ${s.name}`}
                      title={s.isBuiltin ? "Builtin skills can't be deleted" : "Delete skill"}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !isError && skills.length > 0 && (
        <div className="mt-4" style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setEditing("new")}>
            <Plus size={14} strokeWidth={1.5} />
            New skill
          </button>
        </div>
      )}

      {editing !== null && (
        <PromptEditorModal
          kind="skill"
          entity={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
