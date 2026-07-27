import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../ui/cn";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
}

export function Column({ id, children, data, isEmpty }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const empty = isEmpty ?? !children;
  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {empty ? (
        <button className="add-task-btn" style={{ marginTop: 8 }}>
          <Plus size={14} strokeWidth={1.5} />
          Add task...
        </button>
      ) : (
        children
      )}
    </div>
  );
}
