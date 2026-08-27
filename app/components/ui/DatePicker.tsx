import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { parseDateOnly } from "../../lib/dates";

interface DatePickerProps {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string | undefined;
  className?: string | undefined;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function toISODate(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isoToday(): string {
  const now = new Date();
  return toISODate(now.getFullYear(), now.getMonth(), now.getDate());
}

export function DatePicker({ value, onChange, placeholder = "No due date", className }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const base = value ? parseDateOnly(value) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDialogElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      // The popover renders in a PORTAL — both the trigger container and the
      // popover itself count as "inside". Treating the popover as outside
      // would unmount it on mousedown, swallowing the day's click.
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
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

  const toggle = () => {
    if (!open && rootRef.current) {
      // Fixed overlay anchored to the trigger, so the popover escapes any
      // scrollable container (modal body, slideover) that would clip it.
      const rect = rootRef.current.getBoundingClientRect();
      setPopoverStyle({
        position: "fixed",
        top: rect.bottom + 6,
        left: rect.left,
        zIndex: 100,
      });
    }
    setOpen((v) => !v);
  };

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    const pop = popoverRef.current.getBoundingClientRect();
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return;
    // Flip above the trigger when the popover would run off the bottom edge.
    if (pop.bottom > window.innerHeight) {
      setPopoverStyle((prev) => ({ ...prev, top: Math.max(8, root.top - pop.height - 6) }));
    }
    // Clamp to the right edge so the calendar never hangs off-screen.
    if (pop.right > window.innerWidth) {
      setPopoverStyle((prev) => ({ ...prev, left: Math.max(8, window.innerWidth - pop.width - 8) }));
    }
  }, [open]);

  const firstWeekday = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells: { day: number; muted: boolean }[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: 0, muted: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, muted: false });
  while (cells.length % 7 !== 0) {
    cells.push({ day: cells.length - firstWeekday - daysInMonth + 1, muted: true });
  }

  const today = isoToday();
  const monthLabel = `${MONTHS[view.month]} ${view.year}`;

  const prevMonth = () => {
    setView((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 }));
  };
  const nextMonth = () => {
    setView((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 }));
  };

  return (
    <div ref={rootRef} className={cn("datepicker", className)}>
      <button
        type="button"
        className="datepicker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={cn("datepicker-value", !value && "empty")}>{value ?? placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>
      {open &&
        createPortal(
          <dialog
            ref={popoverRef}
            open
            className="datepicker-popover"
            aria-label="Pick a date"
            style={popoverStyle}
          >
          <div className="datepicker-head">
            <button type="button" className="icon-btn" aria-label="Previous month" onClick={prevMonth}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span className="datepicker-month">{monthLabel}</span>
            <button type="button" className="icon-btn" aria-label="Next month" onClick={nextMonth}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
          <div className="datepicker-weekdays">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="datepicker-grid">
            {cells.map((cell, i) => {
              if (cell.day === 0) return <span key={`empty-${i}`} className="datepicker-day empty" />;
              const iso = toISODate(view.year, view.month, cell.day);
              const isToday = iso === today;
              const isSelected = iso === value;
              return (
                <button
                  key={iso}
                  type="button"
                  className={cn(
                    "datepicker-day",
                    cell.muted && "muted",
                    isToday && "today",
                    isSelected && "selected"
                  )}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
          <div className="datepicker-footer">
            <button
              type="button"
              className="datepicker-today"
              onClick={() => {
                const now = new Date();
                setView({ year: now.getFullYear(), month: now.getMonth() });
                onChange(isoToday());
                setOpen(false);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4l3 3" />
              </svg>
              Today
            </button>
            <span className="flex-1" />
            {value && (
              <button
                type="button"
                className="datepicker-clear"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
          </div>
          </dialog>,
          document.body
        )}
    </div>
  );
}
