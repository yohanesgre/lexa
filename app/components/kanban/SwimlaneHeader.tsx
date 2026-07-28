import { ChevronDown, MoreHorizontal, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
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
    <div
      className="swimlane-header"
      onClick={onToggle}
      role={onToggle ? "button" : undefined}
      tabIndex={onToggle ? 0 : undefined}
      onKeyDown={
        onToggle
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }
          : undefined
      }
    >
      <ChevronDown className={cn("chevron", collapsed && "collapsed")} strokeWidth={2} />
      <span className="swimlane-name">{name}</span>
      {count !== undefined && <span className="swimlane-count">{String(count).padStart(3, "0")}</span>}
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
