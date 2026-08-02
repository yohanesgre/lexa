import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Hammer } from "lucide-react";
import { cn } from "../ui/cn";
import { useRecentForgeTasks } from "../../lib/queries";
import type { RecentForgeTask } from "../../lib/api";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function actionLabel(t: RecentForgeTask): string {
  const action = t.action[0].toUpperCase() + t.action.slice(1);
  return t.documentTitle ? `${action} · "${t.documentTitle}"` : action;
}

// Global Forge status pill in the navbar. Shows a spinner while any task is
// running; clicking opens a popover with the recent tasks (including results
// from background runs that finished after the editor popup was closed).
export function ForgeStatus() {
  const { data: tasks = [] } = useRecentForgeTasks();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  const active = tasks.find((t) => t.status === "queued" || t.status === "running");
  const doneCount = tasks.filter((t) => t.status === "completed").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
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
      setPopoverStyle({ position: "fixed", top: rect.bottom + 6, right: window.innerWidth - rect.right, zIndex: 80, width: 320 });
    }
    setOpen((v) => !v);
  };

  // Nothing meaningful to show: no active task and no recent finished tasks.
  if (!active && doneCount === 0 && failedCount === 0) return null;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="forge-status"
        onClick={toggle}
        aria-expanded={open}
        style={
          active
            ? { background: "var(--lx-surface-card)", borderColor: "rgba(240,192,64,0.35)", color: "var(--lx-text-primary)" }
            : failedCount > 0
              ? { background: "var(--lx-bg-danger-subtle)", borderColor: "rgba(255,68,68,0.25)", color: "var(--lx-text-danger)" }
              : { background: "var(--lx-bg-success-subtle)", borderColor: "rgba(74,222,128,0.25)", color: "var(--lx-text-success)" }
        }
      >
        {active ? (
          <>
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />
            Forge · {active.action}
          </>
        ) : failedCount > 0 ? (
          <>
            <Hammer size={12} strokeWidth={1.5} />
            {doneCount > 0 ? `${doneCount} done · ${failedCount} failed` : `${failedCount} failed`}
          </>
        ) : (
          <>
            <Check size={12} strokeWidth={2.5} />
            {doneCount} done
          </>
        )}
      </button>

      {open &&
        createPortal(
          <div className="menu-popover" style={popoverStyle}>
            <div className="dropdown-label">Forge · recent</div>
            {tasks.length === 0 ? (
              <div className="text-xs text-lx-text-muted px-3 py-3">No Forge tasks yet.</div>
            ) : (
              tasks.slice(0, 6).map((t) => (
                <div key={t.id} className="dropdown-item" style={{ height: "auto", padding: "8px 10px", alignItems: "flex-start", flexDirection: "column", gap: 2 }}>
                  <div className="flex items-center gap-2 w-full">
                    <span className="text-xs text-lx-text-secondary truncate" style={{ flex: 1 }}>{actionLabel(t)}</span>
                    <span
                      className={cn(
                        "font-micro text-2xs uppercase tracking-[0.04em] flex-shrink-0",
                        t.status === "completed" && "text-lx-text-success",
                        t.status === "failed" && "text-lx-text-danger",
                        (t.status === "running" || t.status === "queued") && "text-lx-text-warning",
                        (t.status === "cancelled") && "text-lx-text-muted"
                      )}
                    >
                      {STATUS_LABEL[t.status]}
                    </span>
                  </div>
                  <span className="font-micro text-2xs text-lx-text-muted">{t.projectName}</span>
                </div>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
