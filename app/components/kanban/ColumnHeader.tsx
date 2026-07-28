import { MoreHorizontal, Plus, Pencil, SlidersHorizontal, Trash2, Eraser } from "lucide-react";
import { cn } from "../ui/cn";
import { Menu } from "../ui/Menu";

interface ColumnHeaderProps {
  name: string;
  color: string;
  taskCount: number;
  wipLimit: number | null;
  wipFlash?: boolean;
  dimmed?: boolean;
  onOpenCreate?: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ColumnHeader({ name, color, taskCount, wipLimit, wipFlash = false, dimmed = false, onOpenCreate }: ColumnHeaderProps) {
  const wipState =
    wipLimit === null
      ? null
      : wipFlash || taskCount > wipLimit
        ? "exceeded"
        : taskCount >= wipLimit * 0.8
          ? "approaching"
          : "ok";

  return (
    <>
      <div className="column-strip" style={{ background: color || "transparent" }} />
      <div className={cn("column-header", taskCount > 0 && "has-cards")}>
        <div className="flex items-center">
          <span className={cn("column-name", dimmed && "opacity-60")}>{name}</span>
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
            <button type="button" className="menu-item" disabled>
              <Pencil size={14} />
              Rename
            </button>
            <button type="button" className="menu-item" disabled>
              <SlidersHorizontal size={14} />
              Edit column
            </button>
            <div className="menu-separator" />
            <button type="button" className="menu-item danger" disabled>
              <Trash2 size={14} />
              Delete
            </button>
            <button type="button" className="menu-item danger" disabled>
              <Eraser size={14} />
              Clear all tasks
            </button>
          </Menu>
        </div>
      </div>
    </>
  );
}
