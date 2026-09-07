import type { CSSProperties, ReactNode } from "react";

export function WarningNotice({ title, children, className, style }: { title: string; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `card-panel ${className}` : "card-panel"} style={{ background: "var(--lx-bg-warning-subtle)", borderColor: "rgba(240,192,64,0.25)", ...style }}>
      <div className="flex items-center gap-2">
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-warning)" strokeWidth={1.5}><circle cx={12} cy={12} r={10} /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
        <span className="text-sm font-medium" style={{ color: "var(--lx-text-warning)" }}>{title}</span>
      </div>
      <p className="text-xs text-lx-text-secondary mt-1">{children}</p>
    </div>
  );
}
