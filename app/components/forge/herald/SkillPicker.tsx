import { useState, type ReactNode } from "react";
import type { LexaSkill } from "../../../../shared/types";

// Skill chip row (forge-popover.html + herald-chat.html composer). The agent
// is NEVER picked here — the persona is the project's active engine agent,
// resolved server-side; callers pass only that agent's attached skills.
// Chat allows no skill (starts with none); document runs reset to the first
// attached skill. Overflow >6 collapses into the ⋯ dropdown.

const CHIP_MAX = 6;

function ChipRow({ items, selectedId, onSelect, height, fontSize }: {
  items: LexaSkill[];
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
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          className="btn btn-ghost"
          style={chipStyle(selectedId === item.id)}
          onClick={() => onSelect(item.id)}
        >
          {item.name}
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
                  key={item.id}
                  type="button"
                  className="menu-item"
                  style={{ fontSize: 12, color: selectedId === item.id ? "var(--lx-text-primary)" : undefined }}
                  onClick={() => {
                    onSelect(item.id);
                    setRestOpen(false);
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillPicker({ skills, skillId, onSkillChange, layout = "stacked", allowNoSkill = false, trailing }: {
  skills: LexaSkill[];
  skillId: string;
  onSkillChange: (skillId: string) => void;
  // stacked: popover rows (label above chips). inline: chat composer row
  // (label beside chips).
  layout?: "stacked" | "inline";
  // chat: skill optional — starts with none; picking is per message.
  allowNoSkill?: boolean;
  // Extra inline control rendered at the end of the row (chat composer:
  // the Effort picker shares the row per herald-chat.html).
  trailing?: ReactNode;
}) {
  if (layout === "inline") {
    return (
      <div className="flex items-center gap-2 mb-2" style={{ flexWrap: "wrap" }}>
        <span className="prop-label" style={{ marginRight: 2 }}>Skill</span>
        {skills.length > 0 ? (
          <>
            {allowNoSkill && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ height: 24, padding: "0 9px", fontSize: 11, ...(skillId === "" ? { borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" } : {}) }}
                onClick={() => onSkillChange("")}
              >
                None
              </button>
            )}
            <ChipRow items={skills} selectedId={skillId} onSelect={onSkillChange} height={24} fontSize={11} />
          </>
        ) : (
          <span className="text-xs text-lx-text-muted">No skills attached — add them in Settings.</span>
        )}
        {trailing && (
          <>
            <span className="prop-label" style={{ marginLeft: 14, marginRight: 2 }}>Effort</span>
            {trailing}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
      <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Skill</span>
      {skills.length > 0 ? (
        <ChipRow items={skills} selectedId={skillId} onSelect={onSkillChange} height={26} fontSize={12} />
      ) : (
        <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 10px" }}>
          <span className="text-xs text-lx-text-muted">No skills attached — add them in Settings.</span>
        </div>
      )}
    </div>
  );
}
