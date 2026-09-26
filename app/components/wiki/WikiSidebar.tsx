import { useEffect, useRef, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { lockScroll } from "../../lib/scroll-lock";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";

interface WikiSidebarProps {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  overlayActive?: boolean | undefined;
  width?: number | undefined;
  children: ReactNode;
}

export function WikiSidebar({ id, title, open, onToggle, overlayActive = false, width = 280, children }: WikiSidebarProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  useOverlayFocusTrap(overlayActive, panelRef);

  // Esc dismisses the mobile overlay; desktop never owns Escape.
  useEffect(() => {
    if (!overlayActive) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onToggle();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [overlayActive, onToggle]);

  useEffect(() => lockScroll(overlayActive), [overlayActive]);

  if (!open) {
    return (
      <aside id={id} ref={panelRef} className="wiki-edit-sidebar wiki-edit-sidebar-rail flex flex-col">
        <button
          type="button"
          className="sidebar-toggle w-8 h-8 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary rounded"
          onClick={onToggle}
          aria-label="Expand sidebar"
          aria-expanded={false}
          aria-controls={id}
          title={title}
        >
          <PanelRight size={14} strokeWidth={1.5} />
        </button>
      </aside>
    );
  }

  return (
    <>
      <aside
        id={id}
        ref={panelRef}
        className="wiki-edit-sidebar flex flex-col"
        style={{ width }}
        role={overlayActive ? "dialog" : undefined}
        aria-modal={overlayActive ? true : undefined}
        aria-label={overlayActive ? title : undefined}
      >
        <div className="wiki-edit-sidebar-header">
          <button
            type="button"
            className="sidebar-toggle w-8 h-8 p-0 flex items-center justify-center text-lx-text-secondary hover:text-lx-text-primary flex-shrink-0 rounded"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            aria-expanded={true}
            aria-controls={id}
          >
            <PanelRight size={14} strokeWidth={1.5} />
          </button>
          <span className="text-xs font-medium font-body uppercase tracking-[0.05em] text-lx-text-secondary">{title}</span>
        </div>
        {children}
      </aside>
      {overlayActive && (
        <button
          type="button"
          className="wiki-sidebar-backdrop"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onToggle}
        />
      )}
    </>
  );
}
