import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { LexaSkill } from "../../../shared/types";
import type { AssistantReasoningEffort } from "../../../shared/assistant";
import { LEVELS, effortLabel } from "./EffortPicker";

// Rail skill control (assistant-chat-deck design §3.2/§3.6): single-select over
// the agent's attached skills with an explicit `None` — a popover on desktop, a
// bottom sheet on mobile. Replaces the old inline chip row for chat.

const TRIGGER_STYLE: React.CSSProperties = { position: "relative", display: "inline-flex" };
const SHEET_ID = "deck-controls-sheet";

function SkillOptions({ skills, skillId, onPicked }: { skills: LexaSkill[]; skillId: string; onPicked: (id: string) => void }) {
  const options: { id: string; name: string }[] = [{ id: "", name: "None" }, ...skills.map((s) => ({ id: s.id, name: s.name }))];
  return (
    <>
      {options.map((option) => (
        <button key={option.id || "none"} type="button" role="option" aria-selected={option.id === skillId} className="deck-option" onClick={() => onPicked(option.id)}>
          <span>{option.name}</span>
          {option.id === skillId && <Check size={12} strokeWidth={2.5} />}
        </button>
      ))}
    </>
  );
}

// Shared bottom-sheet pattern (wireframes: wiki-sheet over wiki-sheet-scrim):
// Esc or the scrim dismisses, Tab is trapped, focus returns to the trigger.
function DeckSheet({ id, title, onClose, children }: { id?: string; title: string; onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);

  const onSheetKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusables = sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="wiki-sheet-scrim" onClick={() => closeRef.current()} />
      <div ref={sheetRef} className="wiki-sheet" id={id} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onSheetKeyDown}>
        <div className="wiki-sheet-grip" />
        <div className="wiki-sheet-header">
          <span className="wiki-panel-title" id={titleId}>
            {title}
          </span>
          <button type="button" className="icon-btn" aria-label="Close" style={{ width: 28, height: 28 }} onClick={() => closeRef.current()}>
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="wiki-sheet-body">{children}</div>
      </div>
    </>
  );
}

export function SkillSelect({ skills, skillId, onSkillChange, align = "down", disabled }: {
  skills: LexaSkill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  /** "up" opens the popover above the trigger — the docked Deck sits at the
   *  bottom of a 100vh layout, so a downward menu would clip. */
  align?: "up" | "down" | undefined;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = skills.find((s) => s.id === skillId)?.name ?? "None";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    onSkillChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <span ref={rootRef} style={TRIGGER_STYLE}>
      <button
        ref={triggerRef}
        type="button"
        className={`deck-chip${skillId ? " is-set" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Skill — ${current}`}
        onClick={() => setOpen((value) => !value)}
      >
        {current}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          className="menu deck-menu"
          role="listbox"
          aria-label="Skill"
          style={align === "up" ? { top: "auto", bottom: "calc(100% + 4px)" } : undefined}
        >
          <div className="deck-label" style={{ padding: "4px 8px" }}>
            Skill
          </div>
          <SkillOptions skills={skills} skillId={skillId} onPicked={pick} />
        </div>
      )}
    </span>
  );
}

// Mobile M1: the rail collapses to one summary chip reading
// `{skill|No skill} · {effort}`; tapping it opens the bottom sheet with the
// skill list and the effort levels.
export function DeckRailSummary({ skills, skillId, effort, projectEffort, onSkillChange, onEffortChange, disabled }: {
  skills: LexaSkill[];
  skillId: string;
  effort: AssistantReasoningEffort | "";
  projectEffort: AssistantReasoningEffort | null;
  onSkillChange: (id: string) => void;
  onEffortChange: (effort: AssistantReasoningEffort | "") => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const currentSkill = skills.find((s) => s.id === skillId)?.name ?? "No skill";

  const pickSkill = (id: string) => {
    onSkillChange(id);
    setOpen(false);
  };
  const pickEffort = (value: AssistantReasoningEffort | "") => {
    onEffortChange(value);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="deck-summary-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={SHEET_ID}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {currentSkill} · {effortLabel(effort, projectEffort)}
      </button>
      {open && (
        <DeckSheet id={SHEET_ID} title="Skill & effort" onClose={() => setOpen(false)}>
          <span className="deck-label" style={{ display: "block", padding: "6px 16px" }}>
            Skill
          </span>
          <div role="listbox" aria-label="Skill">
            <SkillOptions skills={skills} skillId={skillId} onPicked={pickSkill} />
          </div>
          <span className="deck-label" style={{ display: "block", padding: "10px 16px 6px" }}>
            Effort
          </span>
          <div role="listbox" aria-label="Thinking effort">
            <button type="button" role="option" aria-selected={!effort} className="deck-option" onClick={() => pickEffort("")}>
              <span>Default{projectEffort ? ` · project (${projectEffort})` : " · none set"}</span>
              {!effort && <Check size={12} strokeWidth={2.5} />}
            </button>
            {LEVELS.map((level) => (
              <button key={level.value} type="button" role="option" aria-selected={effort === level.value} className="deck-option" onClick={() => pickEffort(level.value)}>
                <span>{level.label}</span>
                {effort === level.value && <Check size={12} strokeWidth={2.5} />}
              </button>
            ))}
          </div>
        </DeckSheet>
      )}
    </>
  );
}
