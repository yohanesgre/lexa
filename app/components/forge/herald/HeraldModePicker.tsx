import { Zap, Hammer } from "lucide-react";
import { cn } from "../../ui/cn";

// Header segmented control picking the tier per-run (herald-popover.html
// State 1/2). Disabled while any run is active — switching mid-run is blocked
// until the terminal frame.
export type ForgeMode = "herald" | "blacksmith";

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
      aria-label="Forge mode"
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
        <Zap size={11} strokeWidth={1.5} />
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
        <Hammer size={11} strokeWidth={1.5} />
        Blacksmith
      </button>
    </div>
  );
}
