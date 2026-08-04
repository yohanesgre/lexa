import { Plus } from "lucide-react";
import { DndContext, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../ui/cn";
import type { Swimlane } from "../../../shared/types";

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

export function SwimlanesSettingsSection({ swimlanes, sensors, onDragEnd, onEdit, onDelete, onAdd, onShowDescription }: {
  swimlanes: Swimlane[];
  sensors: SensorDescriptor<SensorOptions>[];
  onDragEnd: (e: DragEndEvent) => void;
  onEdit: (s: Swimlane) => void;
  onDelete: (s: Swimlane) => void;
  onAdd: () => void;
  onShowDescription: (s: Swimlane) => void;
}) {
  return (
    <section>
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Swimlanes</h3>
      <p className="text-sm text-lx-text-secondary mb-3 max-w-[560px]">
        Group related work horizontally on the board. Swimlanes are optional.
      </p>

      {swimlanes.length === 0 ? (
        <div className="text-sm text-lx-text-muted py-4">No swimlanes configured.</div>
      ) : (
        <div className="bg-lx-surface-card border border-lx-border rounded-lg overflow-hidden">
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <SortableContext items={swimlanes.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <table className="w-full border-collapse text-[13px] font-body">
                <thead>
                  <tr className="border-b border-lx-border">
                    <th className="w-8 py-2.5 px-3"></th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body" style={{ width: 160 }}>Name</th>
                    <th className="py-2.5 px-3 text-left text-[11px] uppercase tracking-[0.05em] text-lx-text-secondary font-medium font-body">Description</th>
                    <th className="w-[100px] py-2.5 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {swimlanes.map((swimlane) => (
                    <SortableRow key={swimlane.id} id={swimlane.id} className="border-b border-lx-border last:border-b-0">
                      <td className="py-2.5 px-3 text-sm font-medium text-lx-text-primary">{swimlane.name}</td>
                      <td className="py-2.5 px-3" style={{ maxWidth: 0 }}>
                        {swimlane.description ? (
                          <button
                            type="button"
                            className="text-xs text-lx-text-secondary truncate block cursor-pointer"
                            style={{ border: "none", background: "none", padding: 0, maxWidth: "100%" }}
                            title={swimlane.description}
                            onClick={() => onShowDescription(swimlane)}
                          >
                            {swimlane.description}
                          </button>
                        ) : (
                          <span className="text-xs text-lx-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-3">
                          <button type="button" className="btn btn-ghost h-7 px-2.5 text-xs" onClick={() => onEdit(swimlane)} aria-label="Edit swimlane">Edit</button>
                          <button type="button" className="btn btn-danger h-7 w-7 p-0 flex items-center justify-center" onClick={() => onDelete(swimlane)} aria-label="Delete swimlane">
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
        Add Swimlane
      </button>
    </section>
  );
}
