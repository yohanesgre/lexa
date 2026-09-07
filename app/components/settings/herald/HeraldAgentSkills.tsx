import { useAgents, useSkills, useReplaceAgentSkills } from "../../../lib/queries";
import { ENGINE_AGENT_IDS } from "../../../lib/use-hearth-engine";

// ── Agent skill availability (settings-project-herald.html) ──

function AgentSkillColumn({ agentId, agents, skills, onToggle }: {
  agentId: string;
  agents: { id: string; name: string; skillIds: string[] }[];
  skills: { id: string; name: string }[];
  onToggle: (agentId: string, skillIds: string[]) => void;
}) {
  const agent = agents.find((a) => a.id === agentId);
  const attached = new Set(agent?.skillIds ?? []);
  if (!agent) return null;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-medium text-lx-text-primary">{agent.name}</span>
        <span className="font-micro text-2xs uppercase tracking-[0.04em]" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 8px", borderRadius: 9999, fontSize: 10 }}>builtin</span>
      </div>
      <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        {skills.map((skill) => (
          <label key={skill.id} className="check-row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={attached.has(skill.id)}
              onChange={(e) => {
                const next = e.target.checked ? [...attached, skill.id] : [...attached].filter((id) => id !== skill.id);
                onToggle(agent.id, next);
              }}
              aria-label={`${skill.name} — ${agent.name}`}
              style={{ position: "absolute", opacity: 0, width: 14, height: 14 }}
            />
            <div className={`checkbox${attached.has(skill.id) ? " checked" : ""}`} aria-hidden="true" />
            <span className="text-sm text-lx-text-secondary">{skill.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function AgentSkillAvailabilitySection({ projectId }: { projectId: string }) {
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const replaceSkills = useReplaceAgentSkills();

  // Checkbox writes PUT /api/hearth/agents/:id/skills immediately (junction
  // insert/delete); the mutation response refreshes the agents cache via
  // setQueryData.
  const handleToggle = (agentId: string, skillIds: string[]) => {
    replaceSkills.mutate({ id: agentId, skillIds });
  };

  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-medium text-lx-text-primary mb-3">Agent skill availability</h2>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Which skills each builtin agent offers. Availability is junction rows only — no JSON columns on the agent rows. Popover and chat skill chips filter to the active engine agent&apos;s list.
      </p>

      <div className="card-panel card-panel--elevated">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <AgentSkillColumn agentId={ENGINE_AGENT_IDS.herald} agents={agents} skills={skills} onToggle={handleToggle} />
          <AgentSkillColumn agentId={ENGINE_AGENT_IDS.blacksmith} agents={agents} skills={skills} onToggle={handleToggle} />
        </div>
        <div className="field-hint" style={{ marginTop: 10 }}>
          Checkbox writes apply immediately. An agent with zero attached skills can&apos;t generate — the popover shows its empty-skills state with Generate disabled. Both agents are editable + Reset-to-default in Settings → Agents &amp; Skills; never deletable.
        </div>
      </div>
    </section>
  );
}
