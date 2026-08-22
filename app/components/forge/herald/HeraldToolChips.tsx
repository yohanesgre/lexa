import { Check } from "lucide-react";
import type { HeraldToolChip } from "../../../lib/use-herald-stream";

// Tool progress chips streamed from `tool` frames (herald-popover.html
// State 3+4): phase=call renders a spinner chip, phase=result flips it to a
// success check. Chips accumulate for the run.
export function HeraldToolChips({ tools }: { tools: HeraldToolChip[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
      {tools.map((tool) => (
        <span
          key={tool.key}
          className="chip font-micro text-2xs"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 20,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: tool.phase === "result" ? "var(--lx-text-success)" : "var(--lx-text-secondary)",
          }}
        >
          {tool.phase === "call" ? (
            <span className="spinner" style={{ width: 8, height: 8, borderWidth: 1 }} />
          ) : (
            <Check size={9} strokeWidth={2.5} />
          )}
          {tool.label}
        </span>
      ))}
    </div>
  );
}
