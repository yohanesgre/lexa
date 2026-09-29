import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { AssistantReasoningEffort } from "../../../shared/assistant";

// Per-turn thinking-effort picker (assistant-chat.html composer control row).
// "" = following the project default — trigger reads muted "default (N)";
// an explicit level tints the chip with the selected treatment and rides
// the next stream payload only. Locked while a stream is in flight.
export const LEVELS: { value: AssistantReasoningEffort; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// Trigger/summary copy for an unset effort: the resolved project default reads
// inline so members see what actually ships without leaving chat.
export function effortLabel(effort: AssistantReasoningEffort | "", projectEffort: AssistantReasoningEffort | null): string {
  return effort || `default${projectEffort ? ` (${projectEffort})` : ""}`;
}

const ITEM_BASE_STYLE: React.CSSProperties = {
  height: 28,
  fontSize: 12,
  justifyContent: "space-between",
};
const ITEM_SELECTED_STYLE: React.CSSProperties = {
  background: "var(--lx-surface-selected)",
  color: "var(--lx-text-primary)",
};
const itemStyle = (selected: boolean): React.CSSProperties =>
  selected ? { ...ITEM_BASE_STYLE, ...ITEM_SELECTED_STYLE } : ITEM_BASE_STYLE;

export function EffortPicker({ effort, projectEffort, disabled = false, align = "down", onChange }: {
  effort: AssistantReasoningEffort | "";
  projectEffort: AssistantReasoningEffort | null;
  disabled?: boolean | undefined;
  /** "down" (default) opens below the trigger; "up" opens above — use "up"
   *  on mobile where the button sits near the bottom of the viewport and a
   *  downward menu would run off-screen. */
  align?: "up" | "down";
  onChange: (effort: AssistantReasoningEffort | "") => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const total = LEVELS.length + 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (idx + 1) % total;
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = (idx - 1 + total) % total;
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[prev]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={`deck-chip${effort ? " is-set" : ""}`}
        title="Thinking effort applied to the next message"
        aria-label="Thinking effort"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {effortLabel(effort, projectEffort)}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginLeft: 4 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="menu deck-menu" role="listbox" aria-label="Thinking effort" style={align === "up" ? { top: "auto", bottom: "calc(100% + 4px)" } : undefined}>
          <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>Thinking effort</div>
          <button type="button" role="option" aria-selected={!effort} tabIndex={0} className="menu-item" style={itemStyle(!effort)} onClick={() => { onChange(""); setOpen(false); }} onKeyDown={(e) => handleOptionKeyDown(e, 0)}>
            <span>Default{projectEffort ? ` · project (${projectEffort})` : " · none set"}</span>
            {!effort && <Check size={12} strokeWidth={2.5} />}
          </button>
          {LEVELS.map(({ value, label }, idx) => (
            <button key={value} type="button" role="option" aria-selected={effort === value} tabIndex={0} className="menu-item" style={itemStyle(effort === value)} onClick={() => { onChange(value); setOpen(false); }} onKeyDown={(e) => handleOptionKeyDown(e, idx + 1)}>
              <span>{label}</span>
              {effort === value && <Check size={12} strokeWidth={2.5} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SHEET_ID = "deck-controls-sheet";

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

// Mobile M1: the rail collapses to one summary chip reading the effort label;
// tapping it opens the bottom sheet with the effort levels. The thread-level
// skill control is retired — skills are invoked per message with `$name`.
export function DeckRailSummary({ effort, projectEffort, onEffortChange, disabled }: {
  effort: AssistantReasoningEffort | "";
  projectEffort: AssistantReasoningEffort | null;
  onEffortChange: (effort: AssistantReasoningEffort | "") => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

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
        {effortLabel(effort, projectEffort)}
      </button>
      {open && (
        <DeckSheet id={SHEET_ID} title="Effort" onClose={() => setOpen(false)}>
          <span className="deck-label" style={{ display: "block", padding: "6px 16px" }}>
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
