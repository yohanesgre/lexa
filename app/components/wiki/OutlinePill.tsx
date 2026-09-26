import { useEffect, useRef, useState } from "react";
import { List } from "lucide-react";
import { OutlinePanel } from "./OutlinePanel";
import { useScrollSpy } from "../../lib/use-scroll-spy";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";
import { lockScroll } from "../../lib/scroll-lock";
import { useMobilePanel } from "../../lib/viewport";
import type { HeadingOutline } from "../tiptap-render";

const DESKTOP_PANEL_ID = "wiki-outline-panel";
const MOBILE_PANEL_ID = "wiki-outline-sheet-mobile";

interface OutlinePillProps {
  headings: HeadingOutline[];
}

export function OutlinePill({ headings }: OutlinePillProps) {
  const { activeId, scrollTo } = useScrollSpy(headings);
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

  if (!headings.some((heading) => heading.level >= 2)) return null;

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
            scrollTo(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
