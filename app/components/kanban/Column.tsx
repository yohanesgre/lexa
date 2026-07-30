import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../ui/cn";
import { useCreateTask } from "../../lib/queries";

interface ColumnProps {
  id: string;
  children: ReactNode;
  data?: Record<string, unknown>;
  isEmpty?: boolean;
  slug?: string;
  columnId?: string;
  swimlaneId?: string;
  onOpenCreate?: () => void;
}

export function Column({ id, children, data, isEmpty, slug, columnId, swimlaneId, onOpenCreate }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const empty = isEmpty ?? false;
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("high");
  const [type, setType] = useState("feature");
  const createTaskMutation = useCreateTask(slug ?? "");
  const createTask = slug ? createTaskMutation : null;

  const resetForm = () => { setShowForm(false); setTitle(""); setPriority("high"); setType("feature"); };

  const handleSave = () => {
    if (!title.trim() || !createTask || !columnId) return;
    createTask.mutate({
      columnId,
      swimlaneId: swimlaneId ?? "",
      title: title.trim(),
      priority,
      type,
    });
    resetForm();
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Task title"
            autoFocus
          />
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between">
              <span className="prop-label">Priority</span>
              <select className="prop-input" style={{ width: 140, color: priorityColor(priority) }} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="urgent" style={{ color: "#FF4444" }}>● Urgent</option>
                <option value="high" style={{ color: "#FF8844" }}>● High</option>
                <option value="medium" style={{ color: "#F0C040" }}>● Medium</option>
                <option value="low" style={{ color: "#A0A0A0" }}>● Low</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="prop-label">Type</span>
              <select className="prop-input" style={{ width: 140, color: typeColorDot(type) }} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="feature" style={{ color: "#4ADE80" }}>● Feature</option>
                <option value="bug" style={{ color: "#FF4444" }}>● Bug</option>
                <option value="task" style={{ color: "#67E8F9" }}>● Task</option>
                <option value="asset" style={{ color: "#F9A8D4" }}>● Asset</option>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-3">
            <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 10px" }} onClick={resetForm}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 28, padding: "0 10px" }}
              onClick={handleSave}
              disabled={!title.trim() || createTask?.isPending}
            >
              Save
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

function typeColorDot(t: string): string {
  const colors: Record<string, string> = {
    feature: "#4ADE80",
    bug: "#FF4444",
    task: "#67E8F9",
    asset: "#F9A8D4",
  };
  return colors[t] ?? "#6b7280";
}

function priorityColor(p: string): string {
  const colors: Record<string, string> = {
    urgent: "#FF4444",
    high: "#FF8844",
    medium: "#F0C040",
    low: "#A0A0A0",
  };
  return colors[p] ?? "#A0A0A0";
}
