import { Plus } from "lucide-react";
import { DndContext, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../ui/cn";
import type { Column } from "../../../shared/types";

function SortableRow({ id, className, children }: { id: string; className?: string | undefined; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <tr
      ref={setNodeRef}
      className={cn(className, isDragging && "opacity-50")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {children}
    </tr>
  );
}

function ColorSwatch({ color }: { color: string | null }) {
  return color ? (
    <span className="inline-flex items-center gap-2">
      <span className="color-swatch" style={{ background: color }} />
      <span className="text-xs text-lx-text-secondary">{color}</span>
    </span>
  ) : (
    <span className="text-xs text-lx-text-muted">—</span>
  );
}

const formatWipLimit = (limit: number | null) => (limit === null ? "—" : String(limit));
const formatRequiredFields = (fields: string[]) => (fields.length === 0 ? "None" : fields.join(", "));

export function ColumnsSettingsSection({ columns, sensors, onDragEnd, onEdit, onDelete, onAdd }: {
  columns: Column[];
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (e: DragEndEvent) => void;
  onEdit: (c: Column) => void;
  onDelete: (c: Column) => void;
  onAdd: () => void;
}) {
  return (
    <section className="mb-8">
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Columns</h3>
      <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
        Define board columns, WIP limits, required fields per column, and GitHub state mapping.
      </p>

      {columns.length === 0 ? (
        <div className="text-sm text-lx-text-muted py-4">No columns configured.</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <SortableContext items={columns.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <table className="w-full border-collapse text-[13px] font-body" style={{ tableLayout: "fixed" }}>
                <thead>
                  <tr className="border-b border-lx-border">
                    <th className="py-2.5 px-3 whitespace-nowrap" style={{ width: 44 }}></th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Name</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body whitespace-nowrap" style={{ width: 110 }}>Color</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body whitespace-nowrap" style={{ width: 70 }}>WIP Limit</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body" style={{ width: 200 }}>Required Fields</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body whitespace-nowrap" style={{ width: 80 }}>GitHub State</th>
                    <th className="py-2.5 px-3 whitespace-nowrap" style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column) => (
                    <SortableRow key={column.id} id={column.id} className="border-b border-lx-border last:border-b-0">
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-lx-text-muted cursor-grab"><circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" /></svg>
                      </td>
                      <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{column.name}</td>
                      <td className="py-2.5 px-3"><ColorSwatch color={column.color} /></td>
                      <td className="py-2.5 px-3"><span className="font-mono text-2xs text-lx-text-secondary">{formatWipLimit(column.wipLimit)}</span></td>
                      <td className="py-2.5 px-3">
                        <span className={cn("text-xs", column.requiredFields.length === 0 ? "text-lx-text-muted" : "text-lx-text-secondary")}>
                          {formatRequiredFields(column.requiredFields)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        {column.githubState ? (
                          <span className="font-mono text-2xs text-lx-text-success">{column.githubState}</span>
                        ) : (
                          <span className="text-xs text-lx-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-3">
                          <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => onEdit(column)} aria-label="Edit column">Edit</button>
                          <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => onDelete(column)} aria-label="Delete column">
                            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                          </button>
                        </div>
                      </td>
                    </SortableRow>
                  ))}
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        </div>
      )}
      <button type="button" className="btn btn-ghost mt-3" onClick={onAdd}>
        <Plus size={14} strokeWidth={1.5} />
        Add Column
      </button>
    </section>
  );
}
