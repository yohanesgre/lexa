import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useUpdateProviderModel } from "../../lib/queries/herald-admin";
import type { HeraldProviderModel } from "../../../shared/herald";

export function HeraldSortableModelRow({ providerId, model }: { providerId: string; model: HeraldProviderModel }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: model.id });
  const update = useUpdateProviderModel(providerId);
  const mid = model.modelId ?? (model as unknown as { model_id?: string }).model_id ?? model.id;
  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : undefined }}
    >
      <td style={{ textAlign: "center" }}>
        <span
          {...attributes}
          {...listeners}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", color: "var(--lx-text-muted)", padding: 4 }}
          aria-label="Drag to reprioritize"
          title="Drag to reprioritize"
        >
          <svg width={10} height={14} viewBox="0 0 10 14" fill="none" style={{ color: "var(--lx-text-muted)", pointerEvents: "none" }}><circle cx={3} cy={3} r={1.2} fill="currentColor" /><circle cx={7} cy={3} r={1.2} fill="currentColor" /><circle cx={3} cy={7} r={1.2} fill="currentColor" /><circle cx={7} cy={7} r={1.2} fill="currentColor" /><circle cx={3} cy={11} r={1.2} fill="currentColor" /><circle cx={7} cy={11} r={1.2} fill="currentColor" /></svg>
        </span>
      </td>
      <td className="font-mono text-xs" style={{ color: model.enabled ? "var(--lx-text-primary)" : "var(--lx-text-secondary)" }}>{mid}</td>
      <td><span style={{ background: model.kind === "anthropic_compatible" ? "var(--lx-bg-success-subtle)" : model.kind === "openai_responses" ? "rgba(139, 92, 246, 0.12)" : "var(--lx-bg-accent-subtle)", color: model.kind === "anthropic_compatible" ? "var(--lx-text-success)" : model.kind === "openai_responses" ? "#a78bfa" : "var(--lx-text-link)", padding: "2px 6px", borderRadius: 9999, fontSize: 11 }}>{model.kind}</span></td>
      <td className="font-mono text-xs text-lx-text-secondary">{model.priority}</td>
      <td>
        <button
          type="button"
          className={`toggle-switch${model.enabled ? " is-on" : ""}`}
          aria-label={model.enabled ? "Enabled" : "Disabled"}
          onClick={() => update.mutate({ modelId: mid, enabled: !model.enabled })}
          onPointerDown={(e) => e.stopPropagation()}
        />
      </td>
    </tr>
  );
}
