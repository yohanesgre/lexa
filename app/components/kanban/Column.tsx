import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "../ui/cn";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
  onOpenCreate?: () => void;
}

export function Column({ id, children, data, isEmpty, onOpenCreate }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const empty = isEmpty ?? false;

  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {!empty && children}
      <button className="add-task-btn" style={empty ? { marginTop: 8 } : undefined} onClick={onOpenCreate}>
        <Plus size={14} strokeWidth={1.5} />
        Add task...
      </button>
    </div>
  );
}
