import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  gap?: number | undefined;
}

export function Menu({ trigger, children, align = "right", gap = 8 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  // Anchored geometrically to the trigger; recomputed on scroll/resize so the
  // popover stays attached while the page or a scroll container moves.
  const reposition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPopoverStyle({
      position: "fixed",
      top: rect.bottom + gap,
      left: align === "left" ? rect.left : undefined,
      right: align === "right" ? window.innerWidth - rect.right : undefined,
      zIndex: 60,
    });
  }, [align, gap]);

  useEffect(() => {
    if (!open) return;
    reposition();

    function handleMouseDown(event: MouseEvent) {
      // The popover renders in a PORTAL — both the trigger container and the
      // popover itself count as "inside" the menu. Treating the popover as
      // outside would unmount it on mousedown, swallowing the item's click.
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);

  const toggle = () => setOpen((v) => !v);

  const handlePopoverKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = document.activeElement as HTMLElement | null;
    const pos = current ? items.indexOf(current) : -1;
    if (event.key === "ArrowDown") items[pos < 0 ? 0 : (pos + 1) % items.length]!.focus();
    else if (event.key === "ArrowUp") items[pos < 0 ? items.length - 1 : (pos - 1 + items.length) % items.length]!.focus();
    else if (event.key === "Home") items[0]!.focus();
    else items[items.length - 1]!.focus();
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      {trigger({ open, toggle })}
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={cn("menu-popover")}
            role="menu"
            aria-orientation="vertical"
            style={popoverStyle}
            onClick={() => setOpen(false)}
            onKeyDown={handlePopoverKeyDown}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}
