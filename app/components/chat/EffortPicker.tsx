import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { HeraldReasoningEffort } from "../../../shared/herald";

// Per-turn thinking-effort picker (herald-chat.html composer control row).
// "" = following the project default — trigger reads muted "default (N)";
// an explicit level tints the chip with the selected treatment and rides
// the next stream payload only. Locked while a stream is in flight.
const LEVELS: { value: HeraldReasoningEffort; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function EffortPicker({ effort, projectEffort, disabled = false, align = "down", onChange }: {
  effort: HeraldReasoningEffort | "";
  projectEffort: HeraldReasoningEffort | null;
  disabled?: boolean | undefined;
  /** "down" (default) opens below the trigger; "up" opens above — use "up"
   *  on mobile where the button sits near the bottom of the viewport and a
   *  downward menu would run off-screen. */
  align?: "up" | "down";
  onChange: (effort: HeraldReasoningEffort | "") => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const itemStyle = (selected: boolean): React.CSSProperties => ({
    height: 28,
    fontSize: 12,
    justifyContent: "space-between",
    ...(selected ? { background: "var(--lx-surface-selected)", color: "var(--lx-text-primary)" } : {}),
  });

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="btn btn-ghost"
        style={{
          height: 24,
          padding: "0 9px",
          fontSize: 11,
          ...(effort
            ? { borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" }
            : { color: "var(--lx-text-secondary)" }),
        }}
        title="Thinking effort applied to the next message"
        aria-label="Thinking effort"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {effort || `default${projectEffort ? ` (${projectEffort})` : ""}`}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginLeft: 4 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="listbox" aria-label="Thinking effort" style={{ position: "absolute", ...(align === "up" ? { top: "auto", bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)", bottom: "auto" }), left: 0, zIndex: 30, padding: 8, display: "flex", flexDirection: "column", gap: 2, minWidth: 200 }}>
          <div className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ padding: "4px 8px" }}>Thinking effort</div>
          <button type="button" role="option" aria-selected={!effort} className="menu-item" style={itemStyle(!effort)} onClick={() => { onChange(""); setOpen(false); }}>
            <span>Default{projectEffort ? ` · project (${projectEffort})` : " · none set"}</span>
            {!effort && <Check size={12} strokeWidth={2.5} />}
          </button>
          {LEVELS.map(({ value, label }) => (
            <button key={value} type="button" role="option" aria-selected={effort === value} className="menu-item" style={itemStyle(effort === value)} onClick={() => { onChange(value); setOpen(false); }}>
              <span>{label}</span>
              {effort === value && <Check size={12} strokeWidth={2.5} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
