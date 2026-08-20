import { useState } from "react";
import { MoreHorizontal, ChevronDown, ChevronUp, Pencil, Plus, Trash2, Settings, X, Archive } from "lucide-react";
import { cn } from "../ui/cn";
import { Menu } from "../ui/Menu";
import { useUpdateSwimlane, useDeleteSwimlane, useCreateColumn, useArchiveSwimlane, useRestoreSwimlane } from "../../lib/queries";
import { formatDueLabel } from "../../lib/dates";
import { sprintProgress } from "../../lib/progress";
import { SwimlaneForm } from "./SwimlaneForm";
import { ColumnForm } from "./ColumnForm";
import { SprintProgress } from "../milestones/SprintProgress";
import type { Board, Swimlane } from "../../../shared/types";

interface SwimlaneHeaderProps {
  slug: string;
  lane: Swimlane;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  board?: Board;
}

export function SwimlaneHeader({ slug, lane, count, collapsed = false, onToggle, board }: SwimlaneHeaderProps) {
  const updateSwimlane = useUpdateSwimlane(slug);
  const deleteSwimlane = useDeleteSwimlane(slug);
  const createColumn = useCreateColumn(slug);
  const archiveSwimlane = useArchiveSwimlane(slug);
  const restoreSwimlane = useRestoreSwimlane(slug);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState(lane.name);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isAddColumnOpen, setIsAddColumnOpen] = useState(false);
  const [isDescOpen, setIsDescOpen] = useState(false);

  const due = lane.dueAt ? formatDueLabel(lane.dueAt) : null;

  const truncatedDesc = lane.description
    ? lane.description.length > 80
      ? lane.description.slice(0, 80) + "..."
      : lane.description
    : null;

  const handleRename = () => {
    setRenameName(lane.name);
    setIsRenaming(true);
  };

  const submitRename = () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== lane.name) {
      updateSwimlane.mutate({ id: lane.id, name: trimmed });
    }
    setIsRenaming(false);
  };

  const handleDelete = () => {
    deleteSwimlane.mutate({ id: lane.id });
    setDeleteConfirm(false);
  };

  return (
    <>
      <div
        className={cn(
          "swimlane-header",
          lane.kind === "backlog" && "swimlane-backlog",
          !!lane.archivedAt && "swimlane-archived"
        )}
        onClick={onToggle}
      >
        <button
          type="button"
          className="chevron-btn"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={collapsed ? "Expand swimlane" : "Collapse swimlane"}
        >
          <svg
            className={cn("chevron", collapsed && "collapsed")}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isRenaming ? (
          <form
            onSubmit={(e) => { e.preventDefault(); submitRename(); }}
            className="flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              className="prop-input"
              aria-label="Rename swimlane"
              style={{ width: 160, height: 24, fontSize: 13 }}
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onBlur={submitRename}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") { setRenameName(lane.name); setIsRenaming(false); }
              }}
            />
          </form>
        ) : (
          <span className="swimlane-name">{lane.name}</span>
        )}
        {count !== undefined && <span className="swimlane-count">{String(count).padStart(3, "0")}</span>}
        {lane.kind === "sprint" && lane.startAt && lane.dueAt && !lane.archivedAt && (
          <span className="lane-dates">
            <span className="lane-dates-text">
              {formatShortDate(lane.startAt)} → {formatShortDate(lane.dueAt)}
            </span>
            <span className="lane-dates-range" aria-hidden="true">
              <span className="lane-dates-tick lane-dates-tick-start" />
              <span className="lane-dates-line" />
              <span className="lane-dates-tick lane-dates-tick-end" />
            </span>
          </span>
        )}
        {due && lane.kind !== "backlog" && !lane.archivedAt && (
          <span className={cn("lane-due", due.overdue && "lane-due-overdue")}>{due.text}</span>
        )}
        {lane.kind === "sprint" && !lane.archivedAt && board && (() => {
          const p = sprintProgress(board, lane.id);
          return p.total > 0 ? <SprintProgress done={p.done} total={p.total} /> : null;
        })()}
        {lane.kind === "backlog" && !collapsed && (
          <span
            style={{
              fontSize: 11,
              fontFamily: "var(--lx-font-micro)",
              marginLeft: 8,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--lx-text-muted)",
            }}
          >
            system lane
          </span>
        )}
        {truncatedDesc && !collapsed && (
          <>
            <span className="swimlane-desc">{truncatedDesc}</span>
            {lane.description.length > 80 && (
              <button
                type="button"
                className="swimlane-desc-more"
                onClick={(e) => { e.stopPropagation(); setIsDescOpen(true); }}
              >
                read more
              </button>
            )}
          </>
        )}
        <span className="flex-1" />
        {(onToggle || !!lane.archivedAt) && (
          <Menu
            align="right"
            gap={16}
            trigger={({ open, toggle }) => (
              <button
                type="button"
                className={cn("icon-btn", open && "active")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
                title="Swimlane menu"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            {onToggle && (
              <button type="button" className="menu-item" onClick={onToggle}>
                {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                {collapsed ? "Expand" : "Collapse"}
              </button>
            )}
            <button type="button" className="menu-item" onClick={() => setIsSettingsOpen(true)}>
              <Settings size={14} />
              Settings
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-item" onClick={handleRename}>
              <Pencil size={14} />
              Rename
            </button>
            <button type="button" className="menu-item" onClick={() => setIsAddColumnOpen(true)}>
              <Plus size={14} />
              Add column
            </button>
            {!lane.archivedAt && lane.kind === "sprint" && (
              <>
                <div className="menu-separator" />
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => archiveSwimlane.mutate({ id: lane.id })}
                >
                  <Archive size={14} />
                  Archive swimlane
                </button>
              </>
            )}
            {!!lane.archivedAt && (
              <>
                <div className="menu-separator" />
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => restoreSwimlane.mutate({ id: lane.id })}
                >
                  <Archive size={14} />
                  Restore swimlane
                </button>
              </>
            )}
            <div className="menu-separator" />
            <button type="button" className="menu-item danger" onClick={() => setDeleteConfirm(true)}>
              <Trash2 size={14} />
              Delete swimlane
            </button>
          </Menu>
        )}
      </div>

      {isSettingsOpen && (
<SwimlaneForm
        slug={slug}
        swimlane={lane}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSubmit={(input) => {
          updateSwimlane.mutate({
            id: lane.id,
            name: input.name,
            description: input.description ?? undefined,
            dueAt: input.dueAt ?? undefined,
            startAt: input.startAt ?? undefined,
            milestoneId: input.milestoneId ?? undefined,
          });
          setIsSettingsOpen(false);
        }}
      />
      )}

      {isAddColumnOpen && (
<ColumnForm
        slug={slug}
        column={null}
        isOpen={isAddColumnOpen}
        onClose={() => setIsAddColumnOpen(false)}
        onSubmit={(input) => {
          createColumn.mutate({
            name: input.name,
            wipLimit: input.wipLimit,
            requiredFields: input.requiredFields,
            color: input.color ?? undefined,
            githubState: (input.githubState as "open" | "closed" | null | undefined) ?? undefined,
            isDone: input.isDone ?? false,
          });
          setIsAddColumnOpen(false);
        }}
      />
      )}

      {deleteConfirm && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setDeleteConfirm(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
              <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{lane.name}&rsquo;?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This will unassign all tasks in this swimlane. This action cannot be undone.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirm(false)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid" onClick={handleDelete}>
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}

      {isDescOpen && (
        <>
          <button type="button" className="dialog-overlay" onClick={() => setIsDescOpen(false)} aria-label="Close" />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm" style={{ maxWidth: 440 }}>
              <h2 className="font-display text-lg font-medium text-lx-text-primary">{lane.name}</h2>
              <div className="text-sm text-lx-text-secondary font-body leading-5 mt-3">
                {renderSwimlaneDesc(lane.description)}
              </div>
              <div className="flex items-center justify-end gap-2 mt-4">
                <button type="button" className="btn btn-ghost" onClick={() => setIsDescOpen(false)}>Close</button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 11, color: "var(--lx-text-link)" }}
                  onClick={() => { setIsDescOpen(false); setIsSettingsOpen(true); }}
                >
                  Edit in Settings
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

const BOLD_RE = /\*\*(.+?)\*\*/g;const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
const CODE_RE = /`(.+?)`/g;

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const bold = BOLD_RE.exec(remaining);
    const italic = ITALIC_RE.exec(remaining);
    const code = CODE_RE.exec(remaining);

    const matches = [
      bold && { match: bold, type: "bold" as const },
      italic && { match: italic, type: "italic" as const },
      code && { match: code, type: "code" as const },
    ].filter(Boolean).sort((a, b) => a!.match.index - b!.match.index);

    if (matches.length === 0) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }

    const m = matches[0]!;
    const { match, type } = m;
    if (match.index > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, match.index)}</span>);
    }

    if (type === "bold") {
      parts.push(<strong key={key++}>{match[1]}</strong>);
    } else if (type === "italic") {
      parts.push(<em key={key++}>{match[1]}</em>);
    } else {
      parts.push(<code key={key++} className="font-mono text-xs bg-lx-surface-elevated px-1 rounded">{match[1]}</code>);
    }

    remaining = remaining.slice(match.index + match[0].length);
    BOLD_RE.lastIndex = 0;
    ITALIC_RE.lastIndex = 0;
    CODE_RE.lastIndex = 0;
  }

  return parts;
}

function renderSwimlaneDesc(text: string | null): React.ReactNode {
  if (!text) return "No description.";

  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // List item
    if (/^[-*]\s/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(<li key={key++} style={{ marginBottom: 4 }}>{renderInline(lines[i].slice(2))}</li>);
        i++;
      }
      nodes.push(<ul key={key++} style={{ margin: "8px 0 0 0", paddingLeft: 20 }}>{items}</ul>);
      continue;
    }

    // Empty line → paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-list lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^[-*]\s/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(
      <p key={key++} style={{ margin: paraLines.length > 1 ? "8px 0 0 0" : 0 }}>
        {renderInline(paraLines.join(" "))}
      </p>
    );
  }

  return nodes.length > 0 ? nodes : "No description.";
}
