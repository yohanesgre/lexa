import { useEffect, useRef, useState } from "react";
import { List } from "lucide-react";
import { OutlinePanel } from "./OutlinePanel";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import { lockScroll } from "../../lib/scroll-lock";
import { useMobilePanel } from "../../lib/viewport";
import type { HeadingOutline } from "../../lib/markdownToReact";

const DESKTOP_PANEL_ID = "wiki-outline-panel";
const MOBILE_PANEL_ID = "wiki-outline-sheet-mobile";

interface OutlinePillProps {
  headings: HeadingOutline[];
  activeId: string;
  onSelect: (id: string) => void;
}

// The compact affordance: the capsule that opens the popover (desktop/tablet)
// or the bottom sheet (phone). The container query on .wiki-read-shell hides it
// wherever the persistent rail is shown instead.
export function OutlinePill({ headings, activeId, onSelect }: OutlinePillProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useMobilePanel();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const suppressReturnFocusRef = useRef(false);
  useOverlayFocusTrap(open, panelRef, suppressReturnFocusRef);

  const panelId = isMobile ? MOBILE_PANEL_ID : DESKTOP_PANEL_ID;

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node | null;
      if (dockRef.current && target && !dockRef.current.contains(target)) {
        suppressReturnFocusRef.current = true;
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => lockScroll(open && isMobile), [open, isMobile]);

  useEffect(() => {
    if (!isMobile) setOpen(false);
  }, [isMobile]);

  // The rail takes the pill's place once the lane fits it; a resize across that
  // line hides the dock in CSS, so the open panel has to close with it or its
  // scroll lock would outlive the sheet.
  useEffect(() => {
    function closeWhenRailShows() {
      const dock = dockRef.current;
      if (dock && getComputedStyle(dock).display === "none") setOpen(false);
    }
    window.addEventListener("resize", closeWhenRailShows);
    return () => window.removeEventListener("resize", closeWhenRailShows);
  }, []);

  const current = headings.find((heading) => heading.id === activeId) ?? headings[0];

  return (
    <div className="wiki-outline-dock" ref={dockRef}>
      <button
        type="button"
        className="wiki-outline-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Contents"
        onClick={() => setOpen((value) => !value)}
      >
        <List size={14} strokeWidth={1.5} />
        <span className="wiki-outline-pill-label">{current?.text}</span>
      </button>
      {open && (
        <OutlinePanel
          headings={headings}
          activeId={activeId}
          isMobile={isMobile}
          panelId={panelId}
          panelRef={panelRef}
          onSelect={(id) => {
            onSelect(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
