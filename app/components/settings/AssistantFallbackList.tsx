import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AssistantProviderModel } from "../../../shared/assistant";
import type { EnabledModel } from "./assistant-project-logic";

type FallbackRow = AssistantProviderModel & { providerLabel: string; providerId: string };

const rowId = (row: FallbackRow) => `${row.providerId}:${row.modelId}`;

function FallbackRowItem({ row, idx, onMove, onRemove }: {
  row: FallbackRow;
  idx: number;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (idx: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rowId(row) });
  return (
    <div
      ref={setNodeRef}
      className="card-row"
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : undefined }}
    >
      <span
        {...attributes}
        {...listeners}
        style={{ display: "inline-flex", color: "var(--lx-text-muted)", cursor: "grab", touchAction: "none", flexShrink: 0 }}
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ pointerEvents: "none" }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
      </span>
      <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, flexShrink: 0 }}>{idx + 1}</span>
      <span className="font-mono text-xs text-lx-text-primary" style={{ flex: 1 }}>{row.modelId}</span>
      <span style={{ background: row.kind === "anthropic_compatible" ? "var(--lx-bg-success-subtle)" : "var(--lx-bg-accent-subtle)", color: row.kind === "anthropic_compatible" ? "var(--lx-text-success)" : "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, fontSize: 11 }}>{row.kind}</span>
      <span className="font-mono text-xs text-lx-text-muted" style={{ whiteSpace: "nowrap" }}>via {row.providerLabel}</span>
      <div className="flex items-center" style={{ gap: 2, flexShrink: 0 }}>
        <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Move up" onClick={() => onMove(idx, -1)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 19V5M5 12l7-7 7 7" /></svg></button>
        <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Move down" onClick={() => onMove(idx, 1)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M12 5v14M19 12l-7 7-7-7" /></svg></button>
        <button type="button" className="btn btn-ghost" style={{ width: 24, height: 24, padding: 0 }} aria-label="Remove" onClick={() => onRemove(idx)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M18 6L6 18M6 6l12 12" /></svg></button>
      </div>
    </div>
  );
}

// Ordered fallback chain editor (Project Settings → Assistant provider):
// drag-grip rows, ↑/↓ reorder, remove, add-select.
export function AssistantFallbackList({
  fallbacks,
  fallbackRows,
  fallbackOptions,
  addFallbackId,
  onAddFallbackIdChange,
  onAdd,
  onMove,
  onReorder,
  onRemove,
  modelId,
}: {
  fallbacks: string[];
  fallbackRows: FallbackRow[];
  fallbackOptions: EnabledModel[];
  addFallbackId: string;
  onAddFallbackIdChange: (id: string) => void;
  onAdd: () => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (idx: number) => void;
  modelId: string;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = fallbackRows.map(rowId);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(from, to);
  };

  return (
    <div className="card-panel w-fit" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, background: "var(--lx-surface-input)", width: "fit-content", maxWidth: "100%" }}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {fallbackRows.map((row, idx) => (
            <FallbackRowItem key={rowId(row)} row={row} idx={idx} onMove={onMove} onRemove={onRemove} />
          ))}
        </SortableContext>
      </DndContext>
      {fallbacks.length === 0 && <div className="text-xs text-lx-text-muted" style={{ padding: "4px 8px" }}>No fallbacks — primary only.</div>}
      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
        <select id="assistant-add-fallback" aria-label="Add fallback model" className="prop-input flex-1 font-mono" style={{ height: 28, fontSize: 12, maxWidth: 400 }} value={addFallbackId} onChange={(e) => onAddFallbackIdChange(e.target.value)}>
          <option value="">Add fallback…</option>
          {fallbackOptions.map((m) => (
            <option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>{m.modelId} — {m.kind} ({m.providerLabel})</option>
          ))}
          {modelId && <option disabled>{modelId} (primary — already selected)</option>}
        </select>
        <button type="button" className="btn btn-ghost btn-sm" style={{ height: 28 }} onClick={onAdd} disabled={!addFallbackId}>Add</button>
      </div>
    </div>
  );
}
