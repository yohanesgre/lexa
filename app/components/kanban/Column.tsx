import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
  columnId?: string;
  swimlaneId?: string | null;
  onCreateTask?: (input: { columnId: string; swimlaneId?: string | null; title: string }) => Promise<void>;
}

export function Column({ id, children, data, isEmpty, columnId, swimlaneId, onCreateTask }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  const submit = async () => {
    const v = title.trim();
    if (!v || !columnId) return;
    setIsAdding(false);
    setTitle("");
    await onCreateTask?.({ columnId, swimlaneId: swimlaneId ?? null, title: v });
  };

  const cancel = () => {
    setTitle("");
    setIsAdding(false);
  };

  const empty = isEmpty ?? false;

  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {!empty && children}
      {isAdding ? (
        <div className="add-task-form">
          <input
            ref={inputRef}
            className="add-task-input"
            placeholder="Task title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                e.stopPropagation();
                cancel();
              }
            }}
            onBlur={cancel}
          />
        </div>
      ) : (
        <button className="add-task-btn" style={empty ? { marginTop: 8 } : undefined} onClick={() => setIsAdding(true)}>
          <Plus size={14} strokeWidth={1.5} />
          Add task...
        </button>
      )}
    </div>
  );
}
