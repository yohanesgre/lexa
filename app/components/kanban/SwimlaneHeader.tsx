import { ChevronDown } from "lucide-react";
import { cn } from "../ui/cn";

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
    </div>
  );
}
