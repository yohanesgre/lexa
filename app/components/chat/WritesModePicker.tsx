import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { AssistantToolPermissionMode } from "../../../shared/assistant";
import { DeckSheet } from "./EffortPicker";

// Per-thread WRITE-tool permission picker (herald-chat.html composer rail,
// beside Effort). Mirrors EffortPicker: desktop `deck-chip` + `deck-menu`
// listbox; mobile `deck-summary-chip` + wiki-sheet. "ask" is the muted default;
// "auto"/"deny" tint the chip with the selected treatment. Locked while a
// stream runs or approvals pend, and when the project allows no write tools
// (dimmed chip + the hint line from the wireframe).
export const WRITES_MODES: { value: AssistantToolPermissionMode; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
  { value: "deny", label: "Blocked" },
];

export const WRITES_MENU_ID = "writes-menu";
export const WRITES_EMPTY_HINT_ID = "writes-empty-hint";
export const WRITES_EMPTY_HINT =
  "No write tools allowed for this project — enable them in Project Settings → Assistant.";

export function writesModeLabel(mode: AssistantToolPermissionMode): string {
  return WRITES_MODES.find((m) => m.value === mode)?.label ?? "Ask";
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

// The wireframe's one-line hint under the rail (herald-chat.html State 4: a
// `.deck-rail` sibling carrying `padding:4px 10px 8px`). The composer shell
// renders it below the rail, never inside it.
export function WritesEmptyHint() {
  return (
    <span id={WRITES_EMPTY_HINT_ID} className="font-micro text-2xs text-lx-text-muted" style={{ display: "block", padding: "4px 10px 8px" }}>
      {WRITES_EMPTY_HINT}
    </span>
  );
}

export function WritesPicker({
  mode,
  disabled = false,
  noWriteTools = false,
  align = "down",
  onChange,
}: {
  mode: AssistantToolPermissionMode;
  disabled?: boolean | undefined;
  noWriteTools?: boolean | undefined;
  /** "down" (default) opens below the trigger; "up" opens above — used by the
   *  docked Deck, which sits at the bottom of the viewport. */
  align?: "up" | "down";
  onChange: (mode: AssistantToolPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const locked = disabled || noWriteTools;

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const total = WRITES_MODES.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[(idx + 1) % total]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const items = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      items?.[(idx - 1 + total) % total]?.focus();
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
    <>
      <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
        <button
          type="button"
          className={`deck-chip${mode !== "ask" ? " is-set" : ""}`}
          aria-label="Write permission mode"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? WRITES_MENU_ID : undefined}
          aria-describedby={noWriteTools ? WRITES_EMPTY_HINT_ID : undefined}
          disabled={locked}
          onClick={() => setOpen((v) => !v)}
        >
          {writesModeLabel(mode)}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginLeft: 4 }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div
            id={WRITES_MENU_ID}
            className="menu deck-menu"
            role="listbox"
            aria-label="Write permission mode"
            style={align === "up" ? { top: "auto", bottom: "calc(100% + 4px)" } : undefined}
          >
            <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>
              Write permission
            </div>
            {WRITES_MODES.map(({ value, label }, idx) => (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={mode === value}
                tabIndex={0}
                className="menu-item"
                style={itemStyle(mode === value)}
                onClick={() => {
                  onChange(value);
                  setOpen(false);
                }}
                onKeyDown={(e) => handleOptionKeyDown(e, idx)}
              >
                <span>{label}</span>
                {mode === value && <Check size={12} strokeWidth={2.5} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const WRITES_SHEET_ID = "writes-controls-sheet";

// Mobile: the rail collapses the Writes control to one 32px summary chip
// reading the thread's mode; tapping it opens the shared wiki-sheet with the
// three modes. Mirrors DeckRailSummary for Effort.
export function WritesModeSummary({
  mode,
  disabled,
  noWriteTools = false,
  onChange,
}: {
  mode: AssistantToolPermissionMode;
  disabled: boolean;
  noWriteTools?: boolean | undefined;
  onChange: (mode: AssistantToolPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const locked = disabled || noWriteTools;

  const pick = (value: AssistantToolPermissionMode) => {
    onChange(value);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="deck-summary-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={WRITES_SHEET_ID}
        aria-describedby={noWriteTools ? WRITES_EMPTY_HINT_ID : undefined}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        {writesModeLabel(mode)}
      </button>
      {open && (
        <DeckSheet id={WRITES_SHEET_ID} title="Writes" onClose={() => setOpen(false)}>
          <span className="deck-label" style={{ display: "block", padding: "6px 16px" }}>
            Write permission
          </span>
          <div role="listbox" aria-label="Write permission mode">
            {WRITES_MODES.map(({ value, label }) => (
              <button key={value} type="button" role="option" aria-selected={mode === value} className="deck-option" onClick={() => pick(value)}>
                <span>{label}</span>
                {mode === value && <Check size={12} strokeWidth={2.5} />}
              </button>
            ))}
          </div>
        </DeckSheet>
      )}
    </>
  );
}
