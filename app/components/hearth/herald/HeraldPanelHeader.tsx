import { EngineToggle } from "./HeraldModePicker";
import type { HearthMode } from "./HeraldModePicker";
import { HeraldFlameIcon } from "./HeraldFlameIcon";

// Herald tier panel header (herald-popover.html): flame glyph + phase-aware
// right slot.
export function HeraldPanelHeader({
  running,
  done,
  failed,
  engineSwitcherEnabled,
  onModeChange,
}: {
  running: boolean;
  done: boolean;
  failed: boolean;
  engineSwitcherEnabled: boolean;
  onModeChange: (mode: HearthMode) => void;
}) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
      <span className="text-sm font-medium text-lx-text-primary font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <HeraldFlameIcon />
        Hearth
      </span>
      {running ? (
        <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Generating…</span>
      ) : done ? (
        <span className="font-micro text-2xs text-lx-text-success uppercase tracking-[0.04em]">Ready</span>
      ) : failed ? (
        <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">Failed</span>
      ) : engineSwitcherEnabled ? (
        // Member engine toggle renders ONLY when the project enables the
        // switcher; picking Blacksmith hands the popover back to the parent shell.
        <EngineToggle enabled mode="herald" onChange={onModeChange} />
      ) : (
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Herald · AI project assistant</span>
      )}
    </div>
  );
}
