import type { HeraldProviderModel } from "../../../shared/herald";
import type { EnabledModel } from "./herald-project-logic";

type FallbackRow = HeraldProviderModel & { providerLabel: string; providerId: string };

// Ordered fallback chain editor (Project Settings → Herald provider):
// drag-grip rows, ↑/↓ reorder, remove, add-select.
export function HeraldFallbackList({
  fallbacks,
  fallbackRows,
  fallbackOptions,
  addFallbackId,
  onAddFallbackIdChange,
  onAdd,
  onMove,
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
  onRemove: (idx: number) => void;
  modelId: string;
}) {
  return (
    <div className="card-panel w-fit" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4, background: "var(--lx-surface-input)", width: "fit-content", maxWidth: "100%" }}>
      {fallbackRows.map((row, idx) => (
        <div key={`${row.providerId}:${row.modelId}`} className="card-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px" }}>
          <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ color: "var(--lx-text-muted)", cursor: "grab", flexShrink: 0 }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
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
      ))}
      {fallbacks.length === 0 && <div className="text-xs text-lx-text-muted" style={{ padding: "4px 8px" }}>No fallbacks — primary only.</div>}
      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
        <select id="herald-add-fallback" aria-label="Add fallback model" className="prop-input flex-1 font-mono" style={{ height: 28, fontSize: 12, maxWidth: 400 }} value={addFallbackId} onChange={(e) => onAddFallbackIdChange(e.target.value)}>
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
