import { AssistantFlameIcon } from "./AssistantFlameIcon";

// Editor Generate panel header (herald-popover.html): flame glyph + phase-aware
// right slot.
export function AssistantPanelHeader({
  running,
  done,
  failed,
}: {
  running: boolean;
  done: boolean;
  failed: boolean;
}) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
      <span className="text-sm font-medium text-lx-text-primary font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <AssistantFlameIcon />
        AI
      </span>
      {running ? (
        <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Generating…</span>
      ) : done ? (
        <span className="font-micro text-2xs text-lx-text-success uppercase tracking-[0.04em]">Ready</span>
      ) : failed ? (
        <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">Failed</span>
      ) : (
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Assistant · AI project assistant</span>
      )}
    </div>
  );
}
