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
  onUpdate: (id: string, data: Partial<import("../../shared/types").Task>) => void;
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

type OptionItem = { id: string; label: string; color: string };

function ColumnField(props: TaskPropertyBarProps) {
  return (
    <div className="prop-field">
      <span className="prop-label">Column</span>
      {props.isCreate ? (
        <select
          className="prop-input"
          aria-label="Column"
          style={{ minWidth: 120 }}
          value={props.createColumnId}
          onChange={(e) => props.setCreateColumnId(e.target.value)}
        >
          {(props.columns ?? []).map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      ) : (
        <SelectDropdown
          value={props.selectedColumnId}
          options={(props.columns ?? []).map((col) => ({
            value: col.id,
            label: col.name,
          }))}
          onChange={(columnId: string) => {
            props.setSelectedColumnId(columnId);
            props.onUpdate?.(props.task!.id, { columnId });
          }}
          trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
            <button
              type="button"
              className={cn("prop-input", props.missingFields.length > 0 && "is-focused")}
              style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
              onClick={toggle}
            >
              <span>{props.currentColumnName || "—"}</span>
              <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
            </button>
          )}
        />
      )}
    </div>
  );
}

function SwimlaneField(props: TaskPropertyBarProps) {
  return (
    <div className="prop-field">
      <span className="prop-label">Swimlane</span>
      <SelectDropdown
        value={props.selectedSwimlaneId}
        options={(props.swimlanes ?? []).map((lane) => ({
          value: lane.id,
          label: lane.name,
        }))}
        onChange={(swimlaneId: string) => {
          props.setSelectedSwimlaneId(swimlaneId);
          props.onMove?.(props.task!.id, { columnId: props.task!.columnId, swimlaneId });
        }}
        trigger={({ open, toggle }: { open: boolean; toggle: () => void }) => (
          <button
            type="button"
            className="prop-input"
            style={{ minWidth: 120, height: 32, justifyContent: "space-between", display: "inline-flex", alignItems: "center" }}
            onClick={toggle}
          >
            <span>{props.currentSwimlaneName || "—"}</span>
            <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )}
      />
    </div>
  );
}

function PrioritySelect({ value, options, onChange, withGlow }: {
  value: string;
  options: OptionItem[];
  onChange: (priority: string) => void;
  withGlow: boolean;
}) {
  return (
    <SelectDropdown
      value={value}
      options={options.map((priority) => ({
        value: priority.id,
        label: (
          <>
            <span className="priority-dot" style={{ background: priority.color }} />
            {priority.label}
          </>
        ),
      }))}
      onChange={onChange}
      trigger={({ toggle }) => {
        const opt = options.find((p) => p.id === value);
        return (
          <button type="button" className="priority-badge" onClick={toggle} style={{ boxShadow: withGlow ? "var(--lx-focus-glow)" : undefined, color: opt?.color, background: `${opt?.color ?? "#6b6560"}1a` }}>
            <span className="priority-dot" style={{ background: opt?.color ?? "#6b6560" }} />
            {opt?.label ?? "—"}
          </button>
        );
      }}
    />
  );
}

function TypeSelect({ value, options, onChange, withGlow }: {
  value: string;
  options: OptionItem[];
  onChange: (type: string) => void;
  withGlow: boolean;
}) {
  return (
    <SelectDropdown
      value={value}
      options={options.map((type) => ({
        value: type.id,
        label: (
          <span className="type-badge" style={{ background: `${type.color}1a`, color: type.color }}>
            {type.label}
          </span>
        ),
      }))}
      onChange={onChange}
      trigger={({ toggle }) => {
        const opt = options.find((t) => t.id === value);
        return (
          <button type="button" className="type-badge" onClick={toggle} style={{ background: `${opt?.color ?? "#6B6560"}1a`, color: opt?.color ?? "#6B6560", boxShadow: withGlow ? "var(--lx-focus-glow)" : undefined, borderRadius: withGlow ? 4 : undefined }}>
            {opt?.label ?? "—"}
          </button>
        );
      }}
    />
  );
}

function DueDateField({ isCreate, task, createDueAt, setCreateDueAt, onUpdate }: {
  isCreate: boolean;
  task: Task | null;
  createDueAt: string;
  setCreateDueAt: (v: string) => void;
  onUpdate: TaskPropertyBarProps["onUpdate"];
}) {
  return (
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
  );
}

function AssigneeEditorField({ isCreate, task, createAssignees, setCreateAssignees, availableAssignees, missingFields, setEditingAssignees, onUpdate }: {
  isCreate: boolean;
  task: Task | null;
  createAssignees: string[];
  setCreateAssignees: (v: string[]) => void;
  availableAssignees: string[] | undefined;
  missingFields: string[];
  setEditingAssignees: (v: boolean) => void;
  onUpdate: TaskPropertyBarProps["onUpdate"];
}) {
  return (
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
  );
}

function ReadonlyAssigneesField({ task, availableAssignees, setEditingAssignees }: {
  task: Task | null;
  availableAssignees: string[] | undefined;
  setEditingAssignees: (v: boolean) => void;
}) {
  return (
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
  );
}

export function TaskPropertyBar(props: TaskPropertyBarProps) {
  const { isCreate, task, columns, swimlanes, fieldConfig, missingFields,
    selectedSwimlaneId, onUpdate,
    createPriority, setCreatePriority, createType, setCreateType,
    createAssignees, setCreateAssignees, createDueAt, setCreateDueAt, availableAssignees, editingAssignees, setEditingAssignees } = props;
  const priorities = fieldConfig?.priorities ?? [];
  const types = fieldConfig?.types ?? [];
  return (
<div className="property-bar mt-3">
  <ColumnField {...props} />
  {!isCreate && (swimlanes?.length ?? 0) > 0 && <SwimlaneField {...props} />}
  <div className="prop-field">
    <span className="prop-label">Priority</span>
    {isCreate ? (
      <PrioritySelect value={createPriority} options={priorities} onChange={setCreatePriority} withGlow />
    ) : (
      <PrioritySelect value={task!.priority} options={priorities} onChange={(priority) => onUpdate?.(task!.id, { priority })} withGlow={false} />
    )}
  </div>
  <div className="prop-field">
    <span className="prop-label">Type</span>
    {isCreate ? (
      <TypeSelect value={createType} options={types} onChange={setCreateType} withGlow />
    ) : (
      <TypeSelect value={task!.type} options={types} onChange={(type) => onUpdate?.(task!.id, { type })} withGlow={false} />
    )}
  </div>
  <DueDateField isCreate={isCreate} task={task} createDueAt={createDueAt} setCreateDueAt={setCreateDueAt} onUpdate={onUpdate} />
  {isCreate || editingAssignees ? (
    <AssigneeEditorField
      isCreate={isCreate}
      task={task}
      createAssignees={createAssignees}
      setCreateAssignees={setCreateAssignees}
      availableAssignees={availableAssignees}
      missingFields={missingFields}
      setEditingAssignees={setEditingAssignees}
      onUpdate={onUpdate}
    />
  ) : (
    <ReadonlyAssigneesField task={task} availableAssignees={availableAssignees} setEditingAssignees={setEditingAssignees} />
  )}
</div>
  );
}
