import type { ReactNode } from "react";
import { PanelRight } from "lucide-react";

interface WikiSidebarProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  width?: number;
  children: ReactNode;
}

export function WikiSidebar({ title, collapsed, onToggle, width = 280, children }: WikiSidebarProps) {
  if (collapsed) {
    return (
      <aside
        style={{
          width: 36,
          minWidth: 36,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 8,
          background: "var(--lx-surface-elevated)",
          borderLeft: "1px solid var(--lx-border-default)",
        }}
      >
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title={title}
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="flex-shrink-0 flex flex-col bg-lx-surface-elevated"
      style={{
        width,
        overflow: "hidden",
        borderLeft: "1px solid var(--lx-border-default)",
      }}
    >
      <div
        className="flex items-center flex-shrink-0"
        style={{
          height: 48,
          padding: "0 12px",
          borderBottom: "1px solid var(--lx-border-subtle)",
        }}
      >
        <button
          type="button"
          className="w-7 h-7 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
          onClick={onToggle}
          aria-label="Collapse sidebar"
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
        <span className="text-xs font-medium font-body uppercase tracking-[0.05em] text-lx-text-secondary">{title}</span>
      </div>
      {children}
    </aside>
  );
}
