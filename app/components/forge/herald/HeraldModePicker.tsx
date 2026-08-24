import { Flame } from "lucide-react";
import { cn } from "../../ui/cn";
import type { HearthEngine } from "../../../../shared/herald";

// Header segmented control picking the active engine per member
// (forge-popover.html / herald-popover.html toggle variant). Rendered ONLY
// when the project sets engine_switcher_enabled — parents gate on that and
// render nothing otherwise. Disabled while any run is active — switching
// mid-run is blocked until the terminal frame.
export type ForgeMode = HearthEngine;

export function HeraldModePicker({ mode, onChange, disabled }: {
  mode: ForgeMode;
  onChange: (mode: ForgeMode) => void;
  disabled?: boolean;
}) {
  const optionStyle = (selected: boolean): React.CSSProperties => ({
    height: 22,
    padding: "0 10px",
    fontSize: 11,
    ...(selected
      ? { background: "var(--lx-surface-selected)", borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" }
      : { color: "var(--lx-text-secondary)" }),
  });
  return (
    <div
      className="flex items-center"
      role="radiogroup"
      aria-label="Hearth mode"
      style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: 2, opacity: disabled ? 0.45 : undefined, pointerEvents: disabled ? "none" : undefined }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === "herald"}
        className="btn btn-sm"
        style={optionStyle(mode === "herald")}
        onClick={() => onChange("herald")}
      >
        <Flame size={11} strokeWidth={1.5} />
        Herald
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "blacksmith"}
        className={cn("btn btn-sm")}
        style={optionStyle(mode === "blacksmith")}
        onClick={() => onChange("blacksmith")}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" />
        </svg>
        Blacksmith
      </button>
    </div>
  );
}

// Gated wrapper — the single rendering decision for the member engine toggle:
// hidden entirely unless the project enabled the switcher.
export function EngineToggle({ enabled, mode, onChange, disabled }: {
  enabled: boolean;
  mode: ForgeMode;
  onChange: (mode: ForgeMode) => void;
  disabled?: boolean;
}) {
  if (!enabled) return null;
  return <HeraldModePicker mode={mode} onChange={onChange} disabled={disabled} />;
}
