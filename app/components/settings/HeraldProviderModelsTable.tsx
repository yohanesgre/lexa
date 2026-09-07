import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { useReorderProviderModels } from "../../lib/queries/herald-admin";
import type { HeraldProviderModel } from "../../../shared/herald";
import { HeraldSortableModelRow } from "./HeraldSortableModelRow";

// Per-provider model catalog with drag-to-reprioritize (order persists via
// Lexa/ReorderProviderModels).
export function HeraldProviderModelsTable({ providerId, models }: { providerId: string; models: HeraldProviderModel[] }) {
  const reorder = useReorderProviderModels();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = models.findIndex((m) => m.id === String(active.id));
    const newIndex = models.findIndex((m) => m.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const ordered = arrayMove(models, oldIndex, newIndex);
    reorder.mutate({ providerId, orderedIds: ordered.map((m) => m.id) });
  };

  return (
    <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={models.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          <table className="settings-table">
            <thead>
              <tr><th style={{ width: 36 }}></th><th>Model ID</th><th style={{ width: 150 }}>Kind</th><th style={{ width: 70 }}>Priority</th><th style={{ width: 80 }}>Enabled</th></tr>
            </thead>
            <tbody>
              {models.length === 0 ? (
                <tr><td colSpan={5} className="text-xs text-lx-text-muted" style={{ textAlign: "center", padding: 16 }}>No models — fetch from provider.</td></tr>
              ) : models.map((m) => (
                <HeraldSortableModelRow key={m.id} providerId={providerId} model={m} />
              ))}
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </div>
  );
}
