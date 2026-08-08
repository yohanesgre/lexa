import { Plus } from "lucide-react";
import { DndContext, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../ui/cn";
import type { FieldOption } from "../../../shared/types";

function SortableRow({ id, className, children }: { id: string; className?: string; children: React.ReactNode }) {
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

export function OptionSettingsSection({ kind, title, description, options, sensors, onDragEnd, onEdit, onDelete, onAdd }: {
  kind: "priority" | "type";
  title: string;
  description: string;
  options: FieldOption[];
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (e: DragEndEvent) => void;
  onEdit: (opt: FieldOption) => void;
  onDelete: (opt: FieldOption) => void;
  onAdd: () => void;
}) {
  return (
    <section className="mb-8">
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">{title}</h3>
      <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">{description}</p>
      {options.length === 0 ? (
        <div className="text-sm text-lx-text-muted py-4">No {title.toLowerCase()} configured.</div>
      ) : (
        <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <SortableContext items={options.map((o) => o.id)} strategy={verticalListSortingStrategy}>
              <table className="w-full border-collapse text-[13px] font-body" style={{ tableLayout: "fixed" }}>
                <thead>
                  <tr className="border-b border-lx-border">
                    <th className="py-2.5 px-3 whitespace-nowrap" style={{ width: 44 }}></th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Label</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body whitespace-nowrap" style={{ width: 130 }}>Color</th>
                    <th className="py-2.5 px-3 whitespace-nowrap" style={{ width: 100 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {options.map((opt) => (
                    <SortableRow key={opt.id} id={opt.id} className="border-b border-lx-border last:border-b-0">
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-lx-text-muted cursor-grab"><circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" /></svg>
                      </td>
                      <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{opt.label}</td>
                      <td className="py-2.5 px-3">
                        <span className="inline-flex items-center gap-2">
                          <span className="color-swatch" style={{ background: opt.color }} />
                          <span className="text-xs text-lx-text-secondary">{opt.color}</span>
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-3">
                          <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => onEdit(opt)} aria-label={`Edit ${kind}`}>Edit</button>
                          <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => onDelete(opt)} aria-label={`Delete ${kind}`}>
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
        Add {title.slice(0, -1)}
      </button>
    </section>
  );
}
