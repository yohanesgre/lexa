import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { Task } from "../../shared/types";
import { cn } from "./ui/cn";
import { renderDoc } from "./tiptap-render";

function GithubMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Task>) => void;
  columnName?: string;
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
const fmtDate = (iso: string) => iso.slice(0, 10);

export function TaskDetail({ task, onClose, onUpdate, columnName }: TaskDetailProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;

  const [open, setOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const handleClose = () => {
    setOpen(false);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(onClose, 200);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const saveTitle = () => {
    const v = draft.trim();
    if (v && v !== task.title) onUpdate(task.id, { title: v });
    setEditingTitle(false);
  };

  const github = task.github;

  return (
    <>
      <div className={cn("slideover-overlay", !open && "overlay-closed")} onClick={handleClose} />
      <div className={cn("slideover", !open && "slideover-closed")} role="dialog" aria-modal="true">
        <div className="slideover-header border-b border-lx-border-subtle">
          <span className="text-xs font-body text-lx-text-muted">
            {slug ? (
              <>
                <Link to="/$slug" params={{ slug }} search={{}} className="text-lx-text-muted hover:text-lx-text-secondary">
                  {slug}
                </Link>
                {" / Board"}
              </>
            ) : (
              "Board"
            )}
          </span>
          <button className="btn btn-ghost !w-8 !h-8 !p-0" onClick={handleClose} aria-label="Close">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        <div className="px-4 pt-4">
          {editingTitle ? (
            <input
              className="slideover-title-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setDraft(task.title);
                  setEditingTitle(false);
                  e.stopPropagation();
                }
              }}
            />
          ) : (
            <h2
              className="slideover-title"
              onClick={() => {
                setDraft(task.title);
                setEditingTitle(true);
              }}
              title="Click to edit"
            >
              {task.title}
            </h2>
          )}
        </div>

        <div className="property-bar mt-3">
          <div className="prop-field">
            <span className="prop-label">Column</span>
            <span className="text-sm font-body text-lx-text-primary">{columnName ?? "—"}</span>
          </div>
          <div className="prop-field">
            <span className="prop-label">Priority</span>
            <span className={cn("priority-badge", `pb-${task.priority}`)}>
              <span className={cn("priority-dot", `priority-${task.priority}`)} />
              {capitalize(task.priority)}
            </span>
          </div>
          <div className="prop-field">
            <span className="prop-label">Type</span>
            <span className={cn("type-badge", `type-${task.type}`)}>{capitalize(task.type)}</span>
          </div>
          <div className="prop-field">
            <span className="prop-label">Assignee</span>
            <input
              key={task.id}
              className="prop-input w-20"
              defaultValue={task.assignee ?? ""}
              placeholder="—"
              onBlur={(e) => {
                const v = e.target.value.trim();
                const next = v || null;
                if (next !== task.assignee) onUpdate(task.id, { assignee: next });
              }}
            />
          </div>
        </div>

        <div className="slideover-body pt-4">
          {renderDoc(task.description)}

          {github && (
            <div className={cn("github-section mt-4", github.outOfSync && "github-warning")}>
              <div className="flex items-center justify-between">
                <a href={github.url} target="_blank" rel="noreferrer" className="flex items-center gap-2">
                  <GithubMark size={14} className="text-lx-text-link" />
                  <span className="font-mono text-sm font-medium text-lx-text-link">
                    {github.repo} #{github.issueNumber}
                  </span>
                </a>
                <div className="flex items-center gap-2">
                  <span className={cn("sync-dot", github.outOfSync ? "sync-diverged" : "sync-synced")} />
                  <span
                    className={cn(
                      "font-micro text-2xs uppercase tracking-[0.04em]",
                      github.outOfSync ? "text-lx-text-warning" : "text-lx-text-success"
                    )}
                  >
                    {github.outOfSync ? "Out of Sync" : "Synced"}
                  </span>
                </div>
              </div>
              {github.outOfSync && (
                <p className="text-xs text-lx-text-secondary mt-2 leading-4">
                  GitHub issue state does not match this column. Move the card to resync, or check the webhook delivery
                  status.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="slideover-footer">
          <span className="font-mono text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
            Created {fmtDate(task.createdAt)} · Updated {fmtDate(task.updatedAt)}
          </span>
          <button className="btn btn-ghost" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
