import { MoreHorizontal, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "../ui/cn";
import { Menu } from "../ui/Menu";

interface SwimlaneHeaderProps {
  name: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function SwimlaneHeader({ name, count, collapsed = false, onToggle }: SwimlaneHeaderProps) {
  return (
    <div className="swimlane-header" onClick={onToggle}>
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
      <span className="swimlane-name">{name}</span>
      {count !== undefined && <span className="swimlane-count">{String(count).padStart(3, "0")}</span>}
      <span className="flex-1" />
      {onToggle && (
        <Menu
          align="left"
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
          <button type="button" className="menu-item" onClick={onToggle}>
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            {collapsed ? "Expand" : "Collapse"}
          </button>
          <button type="button" className="menu-item" disabled>
            <Pencil size={14} />
            Rename
          </button>
          <div className="menu-separator" />
          <button type="button" className="menu-item" disabled>
            <Plus size={14} />
            Add column
          </button>
          <div className="menu-separator" />
          <button type="button" className="menu-item danger" disabled>
            <Trash2 size={14} />
            Delete swimlane
          </button>
        </Menu>
      )}
    </div>
  );
}
