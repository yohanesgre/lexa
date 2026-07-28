import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import type { Priority, TaskType } from "../../../shared/types";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
  columnId?: string;
  swimlaneId?: string | null;
  onCreateTask?: (input: { columnId: string; swimlaneId?: string | null; title: string; priority?: string; type?: string }) => Promise<void>;
  startAdding?: number;
}

const priorities: { value: Priority; dotClass: string }[] = [
  { value: "urgent", dotClass: "priority-urgent" },
  { value: "high", dotClass: "priority-high" },
  { value: "medium", dotClass: "priority-medium" },
  { value: "low", dotClass: "priority-low" },
];

const types: { value: TaskType; color: string }[] = [
  { value: "feature", color: "var(--lx-type-feature, #4ADE80)" },
  { value: "bug", color: "var(--lx-type-bug, #FF4444)" },
  { value: "task", color: "var(--lx-type-task, #22D3EE)" },
  { value: "asset", color: "var(--lx-type-asset, #F472B6)" },
];

export function Column({ id, children, data, isEmpty, columnId, swimlaneId, onCreateTask, startAdding = 0 }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [type, setType] = useState<TaskType>("task");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  useEffect(() => {
    if (startAdding > 0) setIsAdding(true);
  }, [startAdding]);

  const submit = async () => {
    const v = title.trim();
    if (!v || !columnId) return;
    setIsAdding(false);
    setTitle("");
    setPriority("medium");
    setType("task");
    await onCreateTask?.({ columnId, swimlaneId: swimlaneId ?? null, title: v, priority, type });
  };

  const cancel = () => {
    setTitle("");
    setPriority("medium");
    setType("task");
    setIsAdding(false);
  };

  const empty = isEmpty ?? false;

  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {!empty && children}
      {isAdding ? (
        <div className="inline-add-form">
          <input
            ref={inputRef}
            className="inline-add-input"
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
          />
          <div className="flex items-center gap-1 mt-2">
            <span className="prop-label mr-1">PRI</span>
            {priorities.map((p) => (
              <button
                key={p.value}
                type="button"
                className={cn("option-chip", priority === p.value && "selected")}
                title={`${p.value[0].toUpperCase()}${p.value.slice(1)} priority`}
                onClick={() => setPriority(p.value)}
              >
                <span className={cn("priority-dot", p.dotClass)} />
              </button>
            ))}
            <span className="option-chip-divider" />
            <span className="prop-label mr-1">Type</span>
            {types.map((t) => (
              <button
                key={t.value}
                type="button"
                className={cn("option-chip", type === t.value && "selected")}
                title={t.value[0].toUpperCase() + t.value.slice(1)}
                onClick={() => setType(t.value)}
              >
                <span className="priority-dot" style={{ background: t.color }} />
              </button>
            ))}
          </div>
          <div className="inline-add-actions">
            <button type="button" className="btn btn-ghost" onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!title.trim()}>
              Save
            </button>
          </div>
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
