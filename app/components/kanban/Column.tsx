import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../ui/cn";
import { useCreateTask } from "../../lib/queries";
import type { FieldOption } from "../../../shared/types";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
  slug?: string;
  columnId?: string;
  swimlaneId?: string;
  priorities?: FieldOption[];
  types?: FieldOption[];
  onOpenCreate?: () => void;
}

export function Column({ id, children, data, isEmpty, slug, columnId, swimlaneId, priorities = [], types = [], onOpenCreate }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const empty = isEmpty ?? false;
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<string>(priorities[0]?.id ?? "");
  const [type, setType] = useState<string>(types[0]?.id ?? "");
  const createTaskMutation = useCreateTask(slug ?? "");
  const createTask = slug ? createTaskMutation : null;

  const resetForm = () => {
    setShowForm(false);
    setTitle("");
    setPriority(priorities[0]?.id ?? "");
    setType(types[0]?.id ?? "");
  };

  const handleSave = () => {
    if (!title.trim() || !createTask || !columnId || createTask.isPending) return;
    createTask.mutate(
      {
        columnId,
        swimlaneId: swimlaneId ?? "",
        title: title.trim(),
        priority,
        type,
      },
      { onSettled: resetForm }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") resetForm();
  };

  if (!slug || !columnId) {
    return (
      <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
        {!empty && children}
        <button type="button" className="add-task-btn" style={empty ? { marginTop: 8 } : undefined} onClick={onOpenCreate}>
          <Plus size={14} strokeWidth={1.5} />
          Add task...
        </button>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {!empty && children}
      {showForm ? (
        <div className="inline-add-form">
          <input
            className="prop-input w-full is-focused"
            aria-label="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Task title"
            autoFocus
          />
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between">
              <span className="prop-label">Priority</span>
              <select className="prop-input" aria-label="Priority" style={{ width: 140, color: priorities.find((p) => p.id === priority)?.color ?? "#A0A0A0" }} value={priority} onChange={(e) => setPriority(e.target.value)}>
                {priorities.map((p) => (
                  <option key={p.id} value={p.id} style={{ color: p.color }}>● {p.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="prop-label">Type</span>
              <select className="prop-input" aria-label="Type" style={{ width: 140, color: types.find((t) => t.id === type)?.color ?? "#A0A0A0" }} value={type} onChange={(e) => setType(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.id} style={{ color: t.color }}>● {t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-3">
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetForm} disabled={createTask?.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={!title.trim() || createTask?.isPending}
            >
              {createTask?.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="add-task-btn" style={empty ? { marginTop: 8 } : undefined} onClick={() => setShowForm(true)}>
          <Plus size={14} strokeWidth={1.5} />
          Add task...
        </button>
      )}
    </div>
  );
}
