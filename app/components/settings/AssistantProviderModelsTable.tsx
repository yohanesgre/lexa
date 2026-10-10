import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { useReorderProviderModels } from "../../lib/queries/assistant-admin";
import type { AssistantProviderModel, AssistantSkippedModel } from "../../../shared/assistant";
import { AssistantSortableModelRow } from "./AssistantSortableModelRow";

// Per-provider model catalog with drag-to-reprioritize (order persists via
// Lexa/ReorderProviderModels). `skippedModels` are unsupported-wire catalog ids
// the import refused — never persisted, so they render as inert rows in the
// fetch-result view only (muted `skipped · <reason>` marker, dash priority,
// disabled Enabled toggle).
export function AssistantProviderModelsTable({ providerId, models, skippedModels }: { providerId: string; models: AssistantProviderModel[]; skippedModels?: AssistantSkippedModel[] | undefined }) {
  const reorder = useReorderProviderModels();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const skipped = skippedModels ?? [];

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
              {models.length === 0 && skipped.length === 0 ? (
                <tr><td colSpan={5} className="text-xs text-lx-text-muted" style={{ textAlign: "center", padding: 16 }}>No models yet.</td></tr>
              ) : models.map((m) => (
                <AssistantSortableModelRow key={m.id} providerId={providerId} model={m} />
              ))}
              {skipped.map((s) => (
                <tr key={`skipped-${s.id}`}>
                  <td style={{ textAlign: "center" }}>
                    <svg width={10} height={14} viewBox="0 0 10 14" fill="none" aria-hidden="true" style={{ color: "var(--lx-text-muted)", opacity: 0.5 }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
                  </td>
                  <td className="font-mono text-xs text-lx-text-secondary">{s.id}</td>
                  <td><span className="type-badge" style={{ background: "var(--lx-surface-card-hover)", color: "var(--lx-text-muted)" }}>skipped · {s.reason}</span></td>
                  <td className="font-mono text-xs text-lx-text-muted">—</td>
                  <td>
                    <button type="button" className="toggle-switch" aria-label={s.id} aria-pressed={false} disabled />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </div>
  );
}
