import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, Hammer, List, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "../ui/cn";
import { copyToClipboard } from "../../lib/clipboard";
import { useProjects, useRecentForgeTasks, useRuntimes, useCancelForgeTask, useForgeTaskLogs } from "../../lib/queries";
import type { RecentForgeTask } from "../../lib/api";

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const DISMISSED_KEY = "lxk.forge-dismissed-tasks";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function skillLabel(t: RecentForgeTask): string {
  const skill = t.skillName || t.skillId;
  return t.documentTitle ? `${skill} · "${t.documentTitle}"` : skill;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set((raw ? JSON.parse(raw) : []) as string[]);
  } catch {
    return new Set();
  }
}

// Global Forge status pill in the navbar. Clicking opens a control panel with
// recent tasks: rows navigate to their document, finished tasks can be
// dismissed (local, persists per browser), and running rows show which daemon
// is doing the work. A task result stays reachable in its document's Forge
// popover regardless of dismissal here.
function TaskRowMain({ t, navigable }: { t: RecentForgeTask; navigable: boolean }) {
  const isActive = t.status === "queued" || t.status === "running";
  return (
    <>
      <span className="text-xs text-lx-text-secondary truncate" style={{ flex: 1, minWidth: 0 }}>
        {skillLabel(t)}
      </span>
      <span
        className={cn(
          "font-micro text-2xs uppercase tracking-[0.04em] flex-shrink-0",
          t.status === "completed" && "text-lx-text-success",
          t.status === "failed" && "text-lx-text-danger",
          isActive && "text-lx-text-warning",
          t.status === "cancelled" && "text-lx-text-muted"
        )}
      >
        {STATUS_LABEL[t.status]}
      </span>
      {navigable && <ChevronRight size={12} strokeWidth={1.5} className="text-lx-text-muted flex-shrink-0" />}
    </>
  );
}

export function ForgeStatus() {
  const { data: tasks = [] } = useRecentForgeTasks();
  const { data: projects = [] } = useProjects();
  const { data: runtimes = [] } = useRuntimes();
  const cancelTask = useCancelForgeTask();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  // Copy the task id to the clipboard (for debugging — daemon logs, API,
  // MCP tools). Shows a transient check on the row.
  const copyTaskId = (id: string) => {
    void copyToClipboard(id).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    });
  };

  const visible = useMemo(() => tasks.filter((t) => !dismissed.has(t.id)), [tasks, dismissed]);

  // Live status of the active (queued/running) task — the last log line is
  // shown under its row in the panel.
  const active = visible.find((t) => t.status === "queued" || t.status === "running");
  const activeLogs = useForgeTaskLogs(active?.id ?? null, open && !!active);

  const doneCount = visible.filter((t) => t.status === "completed").length;
  const failedCount = visible.filter((t) => t.status === "failed").length;

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      const insidePill = containerRef.current?.contains(target) ?? false;
      const insidePanel = panelRef.current?.contains(target) ?? false;
      if (!insidePill && !insidePanel) setOpen(false);
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

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
      } catch {
        // storage unavailable (private mode) — dismissal lasts this session
      }
      return next;
    });
  };

  // The pill is ALWAYS visible — idle shows a neutral "Forge" so the Forge
  // entry point (and its panel) is reachable even with no recent tasks.
  const idle = !active && doneCount === 0 && failedCount === 0;

  const slugByProject = new Map(projects.map((p) => [p.id, p.slug]));

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="forge-status"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        style={
          active
            ? { background: "var(--lx-surface-card)", borderColor: "rgba(240,192,64,0.35)", color: "var(--lx-text-primary)" }
            : failedCount > 0
              ? { background: "var(--lx-bg-danger-subtle)", borderColor: "rgba(255,68,68,0.25)", color: "var(--lx-text-danger)" }
              : idle
                ? { background: "var(--lx-surface-card)", borderColor: "var(--lx-border-default)", color: "var(--lx-text-secondary)" }
                : { background: "var(--lx-bg-success-subtle)", borderColor: "rgba(74,222,128,0.25)", color: "var(--lx-text-success)" }
        }
      >
        {active ? (
          <>
            <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />
            Forge · {active.skillName || active.skillId}
          </>
        ) : failedCount > 0 ? (
          <>
            <Hammer size={12} strokeWidth={1.5} />
            {doneCount > 0 ? `${doneCount} done · ${failedCount} failed` : `${failedCount} failed`}
          </>
        ) : idle ? (
          <>
            <Hammer size={12} strokeWidth={1.5} />
            Forge
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
          <div className="menu-popover" role="menu" aria-label="Forge tasks" ref={panelRef} style={popoverStyle}>
            <div className="dropdown-label">Forge · recent</div>
            {visible.length === 0 ? (
              <div className="text-xs text-lx-text-muted px-3 py-3">No Forge tasks yet.</div>
            ) : (
              visible.slice(0, 6).map((t) => {
                const slug = slugByProject.get(t.projectId);
                const runtime = runtimes.find((r) => r.id === t.runtimeId);
                const isActive = t.status === "queued" || t.status === "running";
                const meta =
                  isActive && runtime ? `${t.projectName} · ${runtime.name} · ${runtime.provider}` : t.projectName;
                return (
                  <div
                    key={t.id}
                    role="menuitem"
                    className="dropdown-item"
                    style={{ height: "auto", padding: "8px 10px", alignItems: "flex-start", flexDirection: "column", gap: 2, cursor: "default" }}
                  >
                    <div className="flex items-center gap-2 w-full">
                      {slug &&
                        (t.documentType === "task" ? (
                          <Link
                            to="/$slug"
                            params={{ slug }}
                            search={{ task: t.documentId }}
                            onClick={() => setOpen(false)}
                            className="flex items-center gap-2 w-full"
                            style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}
                          >
                            <TaskRowMain t={t} navigable />
                          </Link>
                        ) : (
                          <Link
                            to="/$slug/wiki/$pageSlug"
                            params={{ slug, pageSlug: t.documentId }}
                            onClick={() => setOpen(false)}
                            className="flex items-center gap-2 w-full"
                            style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}
                          >
                            <TaskRowMain t={t} navigable />
                          </Link>
                        ))}
                      {!slug && <TaskRowMain t={t} navigable={false} />}
                      {isActive && (
                        <button
                          type="button"
                          className="forge-dismiss"
                          aria-label="Cancel Forge task"
                          title="Cancel this Forge task"
                          onClick={() => {
                            cancelTask.mutate(t.id);
                            dismiss(t.id);
                          }}
                          disabled={cancelTask.isPending}
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      )}
                      {TERMINAL_STATUSES.has(t.status) && (
                        <button
                          type="button"
                          className="forge-dismiss"
                          aria-label="Dismiss from panel"
                          title="Dismiss from panel"
                          onClick={() => dismiss(t.id)}
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                    <span className="font-micro text-2xs text-lx-text-muted">{meta}</span>
                    <span
                      className="font-mono"
                      style={{ fontSize: 10, color: "var(--lx-text-muted)", display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>{t.id}</span>
                      <button
                        type="button"
                        className="forge-dismiss"
                        aria-label="Copy task id"
                        title={copiedId === t.id ? "Copied" : "Copy task id"}
                        onClick={() => copyTaskId(t.id)}
                        style={{ width: 16, height: 16, flexShrink: 0 }}
                      >
                        {copiedId === t.id ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={1.5} />}
                      </button>
                    </span>
                    {isActive && activeLogs.data && activeLogs.data.length > 0 && (
                      <span
                        className="font-mono"
                        style={{ fontSize: 10, color: "var(--lx-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%", display: "inline-flex", alignItems: "center", gap: 6 }}
                      >
                        <span className="forge-task-log-live" />
                        {activeLogs.data[activeLogs.data.length - 1].message}
                      </span>
                    )}
                  </div>
                );
              })
            )}
            <Link
              to="/forge"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="dropdown-item"
              style={{ height: 28, textDecoration: "none" }}
            >
              <List size={14} strokeWidth={1.5} />
              <span className="text-xs text-lx-text-secondary">Forge control panel</span>
            </Link>
            <div className="dropdown-separator" />
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="dropdown-item"
              style={{ height: 28, textDecoration: "none" }}
            >
              <Hammer size={14} strokeWidth={1.5} />
              <span className="text-xs text-lx-text-secondary">Forge runtimes</span>
            </Link>
          </div>,
          document.body
        )}
    </div>
  );
}
