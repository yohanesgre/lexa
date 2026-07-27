import { useDroppable } from "@dnd-kit/core";
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
      {empty ? <div className="column-empty">Empty</div> : children}
    </div>
  );
}
