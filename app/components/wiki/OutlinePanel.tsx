import { X } from "lucide-react";
import { OutlineList } from "./OutlineList";
import type { HeadingOutline } from "../tiptap-render";

interface OutlinePanelProps {
  headings: HeadingOutline[];
  activeId: string;
  isMobile: boolean;
  panelId: string;
  panelRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function OutlinePanel({
  headings,
  activeId,
  isMobile,
  panelId,
  panelRef,
  onSelect,
  onClose,
}: OutlinePanelProps) {
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="wiki-sheet-scrim"
          aria-label="Close contents"
          onClick={onClose}
        />
        <div
          id={panelId}
          ref={panelRef}
          className="wiki-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Contents"
        >
          <div className="wiki-sheet-grip" />
          <div className="wiki-sheet-header">
            <span className="wiki-panel-title">Contents</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={onClose}
              style={{ width: 28, height: 28 }}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
          <div className="wiki-sheet-body">
            <nav className="wiki-outline-list">
              <OutlineList headings={headings} activeId={activeId} onSelect={onSelect} />
            </nav>
          </div>
        </div>
      </>
    );
  }

  return (
    <div
      id={panelId}
      ref={panelRef}
      className="wiki-popover wiki-outline-panel"
      role="dialog"
      aria-label="Contents"
    >
      <div className="wiki-panel-header">
        <span className="wiki-panel-title">Contents</span>
      </div>
      <nav className="wiki-outline-list">
        <OutlineList headings={headings} activeId={activeId} onSelect={onSelect} />
      </nav>
    </div>
  );
}
