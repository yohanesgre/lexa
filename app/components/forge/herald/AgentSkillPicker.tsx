import { useState } from "react";
import type { LexaAgent, LexaSkill } from "../../../../shared/types";

// Shared Lexa Agents / Lexa Skills catalog picker (herald-popover.html +
// herald-chat.html). Skills listed belong to the selected agent only;
// changing the agent resets the skill to its first attached unless
// allowNoSkill is set (chat: skill optional, resets to none). Overflow >6
// collapses into the ⋯ dropdown.

const CHIP_MAX = 6;

function ChipRow<T>({ items, selectedId, onSelect, height, fontSize }: {
  items: T[];
  selectedId: string;
  onSelect: (id: string) => void;
  height: number;
  fontSize: number;
}) {
  const [restOpen, setRestOpen] = useState(false);
  const visible = items.length > CHIP_MAX ? items.slice(0, CHIP_MAX) : items;
  const rest = items.length > CHIP_MAX ? items.slice(CHIP_MAX) : [];
  const chipStyle = (selected: boolean): React.CSSProperties => ({
    height,
    padding: `0 ${height === 26 ? 10 : 9}px`,
    fontSize,
    ...(selected
      ? { borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" }
      : {}),
  });
  const idOf = (item: T) => (item as LexaAgent | LexaSkill).id;
  const nameOf = (item: T) => (item as LexaAgent | LexaSkill).name;
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
      {visible.map((item) => (
        <button
          key={idOf(item)}
          type="button"
          className="btn btn-ghost"
          style={chipStyle(selectedId === idOf(item))}
          onClick={() => onSelect(idOf(item))}
        >
          {nameOf(item)}
        </button>
      ))}
      {rest.length > 0 && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={chipStyle(false)}
            aria-label="More options"
            aria-expanded={restOpen}
            onClick={() => setRestOpen(!restOpen)}
          >
            ⋯
          </button>
          {restOpen && (
            <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {rest.map((item) => (
                <button
                  key={idOf(item)}
                  type="button"
                  className="menu-item"
                  style={{ fontSize: 12, color: selectedId === idOf(item) ? "var(--lx-text-primary)" : undefined }}
                  onClick={() => {
                    onSelect(idOf(item));
                    setRestOpen(false);
                  }}
                >
                  {nameOf(item)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface AgentSkillSelection {
  agentId: string;
  skillId: string;
}

export function AgentSkillPicker({ agents, skills, selection, onChange, layout = "stacked", allowNoSkill = false }: {
  agents: LexaAgent[];
  skills: LexaSkill[];
  selection: AgentSkillSelection;
  onChange: (next: AgentSkillSelection) => void;
  // stacked: popover rows (label above chips). inline: chat composer row
  // (label beside chips, toolbar separator between the two groups).
  layout?: "stacked" | "inline";
  // chat: skill optional — agent switch resets to none instead of first skill.
  allowNoSkill?: boolean;
}) {
  const selectedAgent = agents.find((a) => a.id === selection.agentId) ?? null;
  const agentSkillIds = new Set(selectedAgent?.skillIds ?? []);
  const agentSkills = selectedAgent ? skills.filter((s) => agentSkillIds.has(s.id)) : [];

  const pickAgent = (agentId: string) => {
    const nextAgent = agents.find((a) => a.id === agentId);
    const nextSkillIds = new Set(nextAgent?.skillIds ?? []);
    const nextSkills = nextAgent ? skills.filter((s) => nextSkillIds.has(s.id)) : [];
    const keepSkill = nextSkills.some((s) => s.id === selection.skillId);
    onChange({ agentId, skillId: keepSkill ? selection.skillId : allowNoSkill ? "" : nextSkills[0]?.id ?? "" });
  };

  if (layout === "inline") {
    return (
      <div className="flex items-center gap-2 mb-2" style={{ flexWrap: "wrap" }}>
        <span className="prop-label" style={{ marginRight: 2 }}>Lexa Agents</span>
        <ChipRow items={agents} selectedId={selection.agentId} onSelect={pickAgent} height={24} fontSize={11} />
        <span className="toolbar-sep" style={{ height: 14 }} />
        <span className="prop-label" style={{ marginRight: 2 }}>Lexa Skills</span>
        <ChipRow items={agentSkills} selectedId={selection.skillId} onSelect={(skillId) => onChange({ ...selection, skillId })} height={24} fontSize={11} />
      </div>
    );
  }

  return (
    <>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Lexa Agents</span>
        {agents.length > 0 ? (
          <ChipRow items={agents} selectedId={selection.agentId} onSelect={pickAgent} height={26} fontSize={12} />
        ) : (
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 10px" }}>
            <span className="text-xs text-lx-text-muted">No agents — add them in Settings.</span>
          </div>
        )}
      </div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Lexa Skills</span>
        {selectedAgent && agentSkills.length > 0 ? (
          <ChipRow items={agentSkills} selectedId={selection.skillId} onSelect={(skillId) => onChange({ ...selection, skillId })} height={26} fontSize={12} />
        ) : (
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 10px" }}>
            <span className="text-xs text-lx-text-muted">No skills attached — add them in Settings.</span>
          </div>
        )}
      </div>
    </>
  );
}
