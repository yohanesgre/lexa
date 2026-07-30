import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  gap?: number;
}

export function Menu({ trigger, children, align = "right", gap = 8 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPopoverStyle({
        position: "fixed",
        top: rect.bottom + gap,
        left: align === "left" ? rect.left : undefined,
        right: align === "right" ? window.innerWidth - rect.right : undefined,
        zIndex: 60,
      });
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      {trigger({ open, toggle })}
      {open &&
        createPortal(
          <div
            className={cn("menu-popover")}
            style={popoverStyle}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}
