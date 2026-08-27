import { useEffect, useMemo, useRef, useState } from "react";
import { Filter, X } from "lucide-react";
import { cn } from "../ui/cn";
import type { Board } from "../../../shared/types";
import { emptyFilters, isFilterActive, type FilterState } from "../../lib/filters";

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function FilterSection({ label, first, children }: { label: string; first?: boolean | undefined; children: React.ReactNode }) {
  return (
    <>
      <div className="prop-label" style={{ padding: first ? "6px 10px 2px" : "0 10px 2px" }}>
        {label}
      </div>
      {children}
    </>
  );
}

function FilterCheckbox({
  checked,
  onChange,
  icon,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button type="button" className="check-row" onClick={onChange}>
      <span className={cn("checkbox", checked && "checked")} />
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FilterPopover({
  board,
  filters,
  onChange,
}: {
  board: Board;
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}) {
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of board.tasks) for (const a of t.assignees) set.add(a);
    return Array.from(set).sort();
  }, [board.tasks]);
  const hasUnassigned = board.tasks.some((t) => t.assignees.length === 0);

  const toggleColumn = (id: string) => onChange({ ...filters, columns: toggleSet(filters.columns, id) });
  const togglePriority = (value: string) => onChange({ ...filters, priorities: toggleSet(filters.priorities, value) });
  const toggleType = (value: string) => onChange({ ...filters, types: toggleSet(filters.types, value) });
  const toggleAssignee = (value: string) => onChange({ ...filters, assignees: toggleSet(filters.assignees, value) });
  const toggleSwimlane = (value: string) => onChange({ ...filters, swimlanes: toggleSet(filters.swimlanes, value) });
  const clear = () => onChange(emptyFilters());

  const priorities = board.fieldConfig?.priorities ?? [];
  const types = board.fieldConfig?.types ?? [];

  return (
    <div className="menu-popover right filter-popover" style={{ top: 40, minWidth: 256, maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
      <FilterSection label="Column" first>
        {board.columns.map((col) => (
          <FilterCheckbox
            key={col.id}
            checked={filters.columns.has(col.id)}
            onChange={() => toggleColumn(col.id)}
            icon={<span className="priority-dot" style={{ background: col.color || "var(--lx-border-default)" }} />}
            label={col.name}
          />
        ))}
      </FilterSection>

      <div className="menu-separator" />

      <FilterSection label="Priority">
        {priorities.map((p) => (
          <FilterCheckbox
            key={p.id}
            checked={filters.priorities.has(p.id)}
            onChange={() => togglePriority(p.id)}
            icon={<span className="priority-dot" style={{ background: p.color }} />}
            label={p.label}
          />
        ))}
      </FilterSection>

      <div className="menu-separator" />

      <FilterSection label="Type">
        {types.map((t) => (
          <FilterCheckbox
            key={t.id}
            checked={filters.types.has(t.id)}
            onChange={() => toggleType(t.id)}
            icon={<span className="priority-dot" style={{ background: t.color }} />}
            label={t.label}
          />
        ))}
      </FilterSection>

      <div className="menu-separator" />

      <FilterSection label="Assignee">
        {assignees.map((a) => (
          <FilterCheckbox
            key={a}
            checked={filters.assignees.has(a)}
            onChange={() => toggleAssignee(a)}
            icon={<div className="avatar">{a[0]!.toUpperCase()}</div>}
            label={a}
          />
        ))}
        {hasUnassigned && (
          <FilterCheckbox
            checked={filters.assignees.has("")}
            onChange={() => toggleAssignee("")}
            icon={<div className="avatar" style={{ fontSize: 8 }}>?</div>}
            label="Unassigned"
          />
        )}
      </FilterSection>

      {board.swimlanes.length > 0 && (
        <>
          <div className="menu-separator" />
          <FilterSection label="Swimlane">
            {board.swimlanes.map((lane) => (
              <FilterCheckbox
                key={lane.id}
                checked={filters.swimlanes.has(lane.id)}
                onChange={() => toggleSwimlane(lane.id)}
                icon={<span className="priority-dot" style={{ background: "var(--lx-border-default)" }} />}
                label={lane.name}
              />
            ))}
          </FilterSection>
        </>
      )}

      <div className="menu-separator" />
      <button type="button" className="menu-item" onClick={clear}>
        <X size={14} />
        Clear all filters
      </button>
    </div>
  );
}

function FilterCountBadge({ count }: { count: number }) {
  return (
    <span className="font-micro inline-flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-lx-border-focus text-lx-text-inverse text-[10px]">
      {count}
    </span>
  );
}

export function FilterButton({ board, filters, onChange }: { board: Board; filters: FilterState; onChange: (filters: FilterState) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const activeCount =
    filters.columns.size +
    filters.priorities.size +
    filters.types.size +
    filters.assignees.size +
    filters.swimlanes.size;

  const active = isFilterActive(filters);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        className={cn("btn btn-ghost text-sm", active && "border-lx-border-focus text-lx-text-primary")}
        onClick={() => setOpen((v) => !v)}
      >
        <Filter size={14} strokeWidth={1.5} />
        Filter
        {active && <FilterCountBadge count={activeCount} />}
      </button>
      {open && <FilterPopover board={board} filters={filters} onChange={onChange} />}
    </div>
  );
}

export function ActiveFilterBar({ board, filters, onChange }: { board: Board; filters: FilterState; onChange: (filters: FilterState) => void }) {
  const items = useMemo(() => {
    const result: Array<{ label: string; value: string; key: string; remove: () => void }> = [];
    const colMap = new Map(board.columns.map((c) => [c.id, c]));
    const laneMap = new Map(board.swimlanes.map((l) => [l.id, l.name]));
    const priorityMap = new Map((board.fieldConfig?.priorities ?? []).map((x) => [x.id, x.label]));
    const typeMap = new Map((board.fieldConfig?.types ?? []).map((x) => [x.id, x.label]));
    for (const colId of filters.columns) {
      const col = colMap.get(colId);
      if (col) result.push({ label: "Column", value: col.name, key: `col:${colId}`, remove: () => onChange({ ...filters, columns: toggleSet(filters.columns, colId) }) });
    }
    for (const p of filters.priorities) {
      result.push({ label: "Priority", value: priorityMap.get(p) ?? p, key: `pri:${p}`, remove: () => onChange({ ...filters, priorities: toggleSet(filters.priorities, p) }) });
    }
    for (const t of filters.types) {
      result.push({ label: "Type", value: typeMap.get(t) ?? t, key: `type:${t}`, remove: () => onChange({ ...filters, types: toggleSet(filters.types, t) }) });
    }
    for (const a of filters.assignees) {
      result.push({ label: "Assignee", value: a || "Unassigned", key: `asgn:${a}`, remove: () => onChange({ ...filters, assignees: toggleSet(filters.assignees, a) }) });
    }
    for (const s of filters.swimlanes) {
      result.push({ label: "Swimlane", value: laneMap.get(s) ?? "No swimlane", key: `lane:${s}`, remove: () => onChange({ ...filters, swimlanes: toggleSet(filters.swimlanes, s) }) });
    }
    return result;
  }, [filters, board, onChange]);

  const clear = () => onChange(emptyFilters());

  return (
    <div className="filter-bar">
      {items.map((item) => (
        <span key={item.key} className="filter-chip">
          <span className="filter-chip-label">{item.label}</span>
          {item.value}
          <button type="button" className="filter-chip-x" aria-label={`Remove ${item.label} filter`} onClick={item.remove}>
            <X size={10} strokeWidth={2} />
          </button>
        </span>
      ))}
      <button type="button" className="filter-clear" onClick={clear}>
        Clear all
      </button>
    </div>
  );
}
