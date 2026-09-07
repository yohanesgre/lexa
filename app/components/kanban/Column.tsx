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
  isEmpty?: boolean | undefined;
  slug?: string | undefined;
  columnId?: string | undefined;
  swimlaneId?: string | undefined;
  priorities?: FieldOption[];
  types?: FieldOption[];
  onOpenCreate?: () => void;
}

function optionColor(options: FieldOption[], id: string) {
  return options.find((o) => o.id === id)?.color ?? "var(--lx-text-muted)";
}

function AddTaskButton({ onClick, empty }: { onClick?: (() => void) | undefined; empty: boolean }) {
  return (
    <button type="button" className="add-task-btn" style={empty ? { marginTop: 8 } : undefined} onClick={onClick}>
      <Plus size={14} strokeWidth={1.5} />
      Add task...
    </button>
  );
}

interface InlineTaskFormProps {
  title: string;
  onTitleChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  priorities: FieldOption[];
  priority: string;
  onPriorityChange: (value: string) => void;
  types: FieldOption[];
  type: string;
  onTypeChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}

function InlineTaskForm(props: InlineTaskFormProps) {
  return (
    <div className="inline-add-form">
      <input
        className="prop-input w-full is-focused"
        aria-label="Task title"
        value={props.title}
        onChange={(e) => props.onTitleChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        placeholder="Task title"
        autoFocus
      />
      <div className="flex flex-col gap-2 mt-2">
        <div className="flex items-center justify-between">
          <span className="prop-label">Priority</span>
          <select className="prop-input" aria-label="Priority" style={{ width: 140, color: optionColor(props.priorities, props.priority) }} value={props.priority} onChange={(e) => props.onPriorityChange(e.target.value)}>
            {props.priorities.map((p) => (
              <option key={p.id} value={p.id} style={{ color: p.color }}>● {p.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between">
          <span className="prop-label">Type</span>
          <select className="prop-input" aria-label="Type" style={{ width: 140, color: optionColor(props.types, props.type) }} value={props.type} onChange={(e) => props.onTypeChange(e.target.value)}>
            {props.types.map((t) => (
              <option key={t.id} value={t.id} style={{ color: t.color }}>● {t.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onCancel} disabled={props.saving}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={props.onSave} disabled={!props.title.trim() || props.saving}>
          {props.saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

export function Column({ id, children, data, isEmpty, slug, columnId, swimlaneId, priorities = [], types = [], onOpenCreate }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, ...(data ? { data } : {}) });
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
        <AddTaskButton empty={empty} onClick={onOpenCreate} />
      </div>
    );
  }

  return (
    <div ref={setNodeRef} className={cn("column-body", isOver && "drop-target")}>
      {!empty && children}
      {showForm ? (
        <InlineTaskForm
          title={title}
          onTitleChange={setTitle}
          onKeyDown={handleKeyDown}
          priorities={priorities}
          priority={priority}
          onPriorityChange={setPriority}
          types={types}
          type={type}
          onTypeChange={setType}
          onCancel={resetForm}
          onSave={handleSave}
          saving={createTask?.isPending ?? false}
        />
      ) : (
        <AddTaskButton empty={empty} onClick={() => setShowForm(true)} />
      )}
    </div>
  );
}
