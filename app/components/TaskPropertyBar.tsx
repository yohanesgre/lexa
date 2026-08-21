import { ChevronDown } from "lucide-react";
import type { Task } from "../../shared/types";
import { cn } from "./ui/cn";
import { SelectDropdown } from "./ui/SelectDropdown";
import { AssigneeChips } from "./AssigneeChips";
import { DatePicker } from "./ui/DatePicker";

interface TaskPropertyBarProps {
  isCreate: boolean;
  task: Task | null;
  columns: { id: string; name: string }[] | undefined;
  swimlanes: { id: string; name: string }[] | undefined;
  fieldConfig: { priorities: { id: string; label: string; color: string }[]; types: { id: string; label: string; color: string }[] } | undefined;
  missingFields: string[];
  currentColumnName: string | null;
  currentSwimlaneName: string | null;
  selectedColumnId: string;
  setSelectedColumnId: (v: string) => void;
  selectedSwimlaneId: string;
  setSelectedSwimlaneId: (v: string) => void;
  onUpdate: (id: string, data: { columnId?: string; priority?: string; type?: string; assignees?: string[]; dueAt?: string | null }) => void;
  onMove: (id: string, data: { columnId: string; swimlaneId: string }) => void;
  createColumnId: string;
  setCreateColumnId: (v: string) => void;
  createPriority: string;
  setCreatePriority: (v: string) => void;
  createType: string;
  setCreateType: (v: string) => void;
  createAssignees: string[];
  setCreateAssignees: (v: string[]) => void;
  createDueAt: string;
  setCreateDueAt: (v: string) => void;
  availableAssignees: string[] | undefined;
  editingAssignees: boolean;
  setEditingAssignees: (v: boolean) => void;
}

export function TaskPropertyBar(props: TaskPropertyBarProps) {
  const { isCreate, task, columns, swimlanes, fieldConfig, missingFields, currentColumnName, currentSwimlaneName,
    selectedColumnId, setSelectedColumnId, selectedSwimlaneId, setSelectedSwimlaneId, onUpdate, onMove,
    createColumnId, setCreateColumnId, createPriority, setCreatePriority, createType, setCreateType,
    createAssignees, setCreateAssignees, createDueAt, setCreateDueAt, availableAssignees, editingAssignees, setEditingAssignees } = props;
  const priorities = fieldConfig?.priorities ?? [];
  const types = fieldConfig?.types ?? [];
  return (
<div className="property-bar mt-3">
  <div className="prop-field">
    <span className="prop-label">Column</span>
    {isCreate ? (
      <select
        className="prop-input"
        aria-label="Column"
        style={{ minWidth: 120 }}
        value={createColumnId}
        onChange={(e) => setCreateColumnId(e.target.value)}
      >
        {(columns ?? []).map((column) => (
          <option key={column.id} value={column.id}>
            {column.name}
          </option>
        ))}
      </select>
    ) : (
      <SelectDropdown
        value={selectedColumnId}
        options={(columns ?? []).map((col) => ({
          value: col.id,
          label: col.name,
        }))}
        onChange={(columnId: string) => {
          setSelectedColumnId(columnId);
          onUpdate?.(task!.id, { columnId });
        }}
        trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
          <button
            type="button"
            className={cn("prop-input", missingFields.length > 0 && "is-focused")}
            style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
            onClick={toggle}
          >
            <span>{currentColumnName || "—"}</span>
            <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )}
      />
    )}
  </div>
  {!isCreate && (swimlanes?.length ?? 0) > 0 && (
    <div className="prop-field">
      <span className="prop-label">Swimlane</span>
      <SelectDropdown
        value={selectedSwimlaneId}
        options={(swimlanes ?? []).map((lane) => ({
          value: lane.id,
          label: lane.name,
        }))}
        onChange={(swimlaneId: string) => {
          setSelectedSwimlaneId(swimlaneId);
          onMove?.(task!.id, { columnId: task!.columnId, swimlaneId });
        }}
        trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
          <button
            type="button"
            className="prop-input"
            style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
            onClick={toggle}
          >
            <span>{currentSwimlaneName || "—"}</span>
            <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )}
      />
    </div>
  )}
  <div className="prop-field">
    <span className="prop-label">Priority</span>
    {isCreate ? (
      <SelectDropdown
        value={createPriority}
        options={(fieldConfig?.priorities ?? []).map((priority) => ({
          value: priority.id,
          label: (
            <>
              <span className="priority-dot" style={{ background: priority.color }} />
              {priority.label}
            </>
          ),
        }))}
        onChange={(priority) => setCreatePriority(priority)}
        trigger={({ toggle }) => {
          const opt = (fieldConfig?.priorities ?? []).find((p) => p.id === createPriority);
          return (
            <button type="button" className="priority-badge" onClick={toggle} style={{ boxShadow: "var(--lx-focus-glow)", color: opt?.color, background: `${opt?.color ?? "#6b6560"}1a` }}>
              <span className="priority-dot" style={{ background: opt?.color ?? "#6b6560" }} />
              {opt?.label ?? "—"}
            </button>
          );
        }}
      />
    ) : (
      <SelectDropdown
        value={task!.priority}
        options={(fieldConfig?.priorities ?? []).map((priority) => ({
          value: priority.id,
          label: (
            <>
              <span className="priority-dot" style={{ background: priority.color }} />
              {priority.label}
            </>
          ),
        }))}
        onChange={(priority) => onUpdate?.(task!.id, { priority })}
        trigger={({ toggle }) => {
          const opt = (fieldConfig?.priorities ?? []).find((p) => p.id === task!.priority);
          return (
            <button type="button" className="priority-badge" onClick={toggle} style={{ color: opt?.color, background: `${opt?.color ?? "#6b6560"}1a` }}>
              <span className="priority-dot" style={{ background: opt?.color ?? "#6b6560" }} />
              {opt?.label ?? "—"}
            </button>
          );
        }}
      />
    )}
  </div>
  <div className="prop-field">
    <span className="prop-label">Type</span>
    {isCreate ? (
      <SelectDropdown
        value={createType}
        options={(fieldConfig?.types ?? []).map((type) => ({
          value: type.id,
          label: (
            <span className="type-badge" style={{ background: `${type.color}1a`, color: type.color }}>
              {type.label}
            </span>
          ),
        }))}
        onChange={(type) => setCreateType(type)}
        trigger={({ toggle }) => {
          const opt = (fieldConfig?.types ?? []).find((t) => t.id === createType);
          return (
            <button type="button" className="type-badge" onClick={toggle} style={{ background: `${opt?.color ?? "#6B6560"}1a`, color: opt?.color ?? "#6B6560", boxShadow: "var(--lx-focus-glow)", borderRadius: 4 }}>
              {opt?.label ?? "—"}
            </button>
          );
        }}
      />
    ) : (
      <SelectDropdown
        value={task!.type}
        options={(fieldConfig?.types ?? []).map((type) => ({
          value: type.id,
          label: (
            <span className="type-badge" style={{ background: `${type.color}1a`, color: type.color }}>
              {type.label}
            </span>
          ),
        }))}
        onChange={(type) => onUpdate?.(task!.id, { type })}
        trigger={({ toggle }) => {
          const opt = (fieldConfig?.types ?? []).find((t) => t.id === task!.type);
          return (
            <button type="button" className="type-badge" onClick={toggle} style={{ background: `${opt?.color ?? "#6B6560"}1a`, color: opt?.color ?? "#6B6560" }}>
              {opt?.label ?? "—"}
            </button>
          );
        }}
      />
    )}
  </div>
  <div className="prop-field">
    <span className="prop-label">Due date</span>
    {isCreate ? (
      <DatePicker
        value={createDueAt === "" ? null : createDueAt}
        onChange={(v) => setCreateDueAt(v ?? "")}
      />
    ) : (
      <DatePicker
        value={task?.dueAt ?? null}
        onChange={(v) => onUpdate?.(task!.id, { dueAt: v })}
      />
    )}
  </div>
  {isCreate || editingAssignees ? (
    <div className="prop-field" style={{ flexWrap: "wrap" }}>
      <span className="prop-label">Assignees</span>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ width: 20, height: 20, padding: 0, flexShrink: 0 }}
        onClick={() => setEditingAssignees(false)}
        title="Done editing assignees"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
      <AssigneeChips
        key={isCreate ? "create" : task!.id}
        assignees={isCreate ? createAssignees : task!.assignees ?? []}
        availableAssignees={availableAssignees ?? []}
        placeholder="Add assignee..."
        inputClassName={cn("prop-input", missingFields.includes("assignee") && "is-focused")}
        inputStyle={{ minWidth: 120, maxWidth: 120, padding: "6px 8px", border: "1px solid var(--lx-border-focus)", borderRadius: 6 }}
        onChange={isCreate
          ? setCreateAssignees
          : (next: string[]) => onUpdate?.(task!.id, { assignees: next })}
      />
    </div>
  ) : (
    <div className="prop-field">
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span className="prop-label">Assignees</span>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: 20, height: 20, padding: 0 }}
          onClick={() => setEditingAssignees(true)}
          title="Edit assignees"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      </div>
      <AssigneeChips
        readonly
        compact
        assignees={task!.assignees ?? []}
        availableAssignees={availableAssignees ?? []}
      />
    </div>
  )}
</div>
  );
}
