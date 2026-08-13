import { useState } from "react";
import { MoreHorizontal, Plus, SlidersHorizontal, Trash2, Eraser } from "lucide-react";
import { cn } from "../ui/cn";
import { Menu } from "../ui/Menu";
import { useBoard, useUpdateColumn, useDeleteColumn, useDeleteTask } from "../../lib/queries";
import { ColumnForm } from "./ColumnForm";
import type { Column } from "../../../shared/types";

interface ColumnHeaderProps {
  slug: string;
  column: Column;
  taskCount: number;
  wipLimit: number | null;
  wipFlash?: boolean;
  dimmed?: boolean;
  onOpenCreate?: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ColumnHeader({ slug, column, taskCount, wipLimit, wipFlash = false, dimmed = false, onOpenCreate }: ColumnHeaderProps) {
  const { data: board } = useBoard(slug);
  const deleteColumn = useDeleteColumn(slug);
  const deleteTask = useDeleteTask(slug);
  const updateColumn = useUpdateColumn(slug);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  const wipState =
    wipLimit === null
      ? null
      : wipFlash || taskCount > wipLimit
        ? "exceeded"
        : taskCount >= wipLimit * 0.8
          ? "approaching"
          : "ok";

  const handleDelete = () => {
    deleteColumn.mutate({ id: column.id });
    setDeleteConfirm(false);
  };

  const handleClearTasks = () => {
    const tasks = board?.tasks.filter((t) => t.columnId === column.id) ?? [];
    for (const t of tasks) {
      deleteTask.mutate({ id: t.id });
    }
    setClearConfirm(false);
  };

  return (
    <>
      <div className="column-strip" style={{ background: column.color || "transparent" }} />
      <div className={cn("column-header", taskCount > 0 && "has-cards")}>
        <div className="flex items-center">
          <span className={cn("column-name", dimmed && "opacity-60")}>{column.name}</span>
          <span className={cn("column-count", dimmed && "opacity-60")}>{pad(taskCount)}</span>
        </div>
        <div className="flex items-center gap-1">
          {wipLimit !== null && wipState !== null && (
            <span className={cn("wip-badge", `wip-${wipState}`, wipFlash && "wip-flash")}>
              {pad(taskCount)}/{pad(wipLimit)}
            </span>
          )}
          <Menu
            align="right"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                className={cn("icon-btn", open && "active")}
                onClick={toggle}
                title="Column menu"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
            <button type="button" className="menu-item" onClick={onOpenCreate}>
              <Plus size={14} />
              Add task
            </button>
            <button type="button" className="menu-item" onClick={() => setIsEditOpen(true)}>
              <SlidersHorizontal size={14} />
              Settings
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-item danger" onClick={() => setDeleteConfirm(true)}>
              <Trash2 size={14} />
              Delete
            </button>
            <button type="button" className="menu-item danger" onClick={() => setClearConfirm(true)}>
              <Eraser size={14} />
              Clear all tasks
            </button>
          </Menu>
        </div>
      </div>

      {isEditOpen && (
<ColumnForm
        slug={slug}
        column={column}
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSubmit={(input) => {
          updateColumn.mutate({
            id: column.id,
            name: input.name,
            wipLimit: input.wipLimit,
            requiredFields: input.requiredFields,
            color: input.color ?? undefined,
            githubState: input.githubState as "open" | "closed" | undefined,
            isDone: input.isDone ?? false,
          });
          setIsEditOpen(false);
        }}
      />
      )}

      {deleteConfirm && (
        <>
          <button
            type="button"
            className="dialog-overlay"
            aria-label="Close dialog"
            onClick={() => setDeleteConfirm(false)}
            />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-labelledby="delete-column-title">
              <h2 id="delete-column-title" className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{column.name}&rsquo;?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This will remove all tasks in this column. This action cannot be undone.
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

      {clearConfirm && (
        <>
          <button
            type="button"
            className="dialog-overlay"
            aria-label="Close dialog"
            onClick={() => setClearConfirm(false)}
            />
          <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
            <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-labelledby="clear-column-title">
              <h2 id="clear-column-title" className="font-display text-lg font-medium text-lx-text-primary">Clear all tasks?</h2>
              <p className="text-sm text-lx-text-secondary mt-3 leading-5">
                This will permanently delete all {taskCount} task{taskCount !== 1 ? "s" : ""} in <span className="font-medium text-lx-text-primary">&lsquo;{column.name}&rsquo;</span>. This action cannot be undone.
              </p>
              <div className="flex items-center gap-2 mt-4 justify-end">
                <button type="button" className="btn btn-ghost" onClick={() => setClearConfirm(false)}>Cancel</button>
                <button type="button" className="btn btn-danger-solid" onClick={handleClearTasks}>
                  <Eraser size={14} strokeWidth={1.5} />
                  Clear
                </button>
              </div>
            </dialog>
          </div>
        </>
      )}
    </>
  );
}
