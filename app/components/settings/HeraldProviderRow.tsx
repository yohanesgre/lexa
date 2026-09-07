import { Fragment } from "react";
import { ChevronDown, RefreshCw, Settings, Trash2 } from "lucide-react";
import type { HeraldProvider } from "../../../shared/herald";
import { providerBaseUrl } from "./herald-providers-logic";
import { HeraldProviderModelsTable } from "./HeraldProviderModelsTable";

export type ProviderTestState = { state: "pending" | "ok" | "fail"; latencyMs?: number | undefined; code?: string | undefined; message?: string | undefined };

// Registry table row + expandable models sub-table (Workspace → Herald
// Providers). Row click toggles the models panel.
export function HeraldProviderRow({
  provider,
  expanded,
  testState,
  fetchPending,
  onToggle,
  onTest,
  onFetch,
  onEdit,
  onDelete,
}: {
  provider: HeraldProvider;
  expanded: boolean;
  testState: ProviderTestState | undefined;
  fetchPending: boolean;
  onToggle: () => void;
  onTest: () => void;
  onFetch: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const bu = providerBaseUrl(provider);
  const models = provider.models ?? [];
  const enabled = models.filter((m) => m.enabled).length;
  const total = models.length;
  return (
    <Fragment>
      <tr style={{ cursor: "pointer" }} className="is-expandable" onClick={onToggle}>
        <td style={{ maxWidth: 0 }}>
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" title={provider.label} className="flex items-center gap-1.5 text-sm font-medium text-lx-text-primary hover:bg-[var(--lx-surface-card-hover)] rounded min-w-0 flex-1 truncate text-left" style={{ background: "transparent", border: "none", cursor: "pointer", padding: "2px 6px 2px 0", margin: "-2px 0 -2px -4px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
              <ChevronDown size={12} strokeWidth={2} style={{ color: "var(--lx-text-secondary)", flexShrink: 0, transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 150ms var(--lx-ease-out)" }} />
              <span className="truncate" title={provider.label} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{provider.label}</span>
            </button>
          </div>
        </td>
        <td className="font-mono text-xs text-lx-text-secondary">{bu}</td>
        <td className="text-xs text-lx-text-secondary">{total === 0 ? "—" : `${enabled} enabled · ${total} total`}</td>
        <td style={{ textAlign: "right" }}>
          <div className="table-actions">
            {testState?.state === "pending" ? (
              <span className="flex items-center justify-end gap-2" style={{ display: "inline-flex" }}>
                <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                <span className="text-xs text-lx-text-secondary">Testing…</span>
              </span>
            ) : testState?.state === "ok" ? (
              <span className="font-micro text-2xs" style={{ background: "var(--lx-bg-success-subtle)", color: "var(--lx-text-success)", padding: "2px 6px", borderRadius: 9999 }}>OK · {testState.latencyMs} ms</span>
            ) : testState?.state === "fail" ? (
              <span className="font-mono text-xs" style={{ color: "var(--lx-text-danger)" }}>{testState.code}</span>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onFetch(); }} disabled={fetchPending} title="Sync models from provider without expanding">
              <RefreshCw size={12} strokeWidth={1.5} className={fetchPending ? "animate-spin" : undefined} />
              Fetch
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); onTest(); }}>
              Test
            </button>
            <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Edit provider" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
              <Settings size={14} strokeWidth={1.5} />
            </button>
            <button type="button" className="btn btn-danger btn-icon-sm" aria-label="Delete provider" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ padding: 0, border: "none", background: "var(--lx-surface-elevated)" }}>
            <div style={{ padding: "12px 16px", borderTop: "1px solid var(--lx-border-subtle)" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-lx-text-primary">Models — {provider.label}</span>
                  <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{enabled} enabled of {total} · drag to reprioritize</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={onFetch} disabled={fetchPending}>
                  <RefreshCw size={12} strokeWidth={1.5} className={fetchPending ? "animate-spin" : undefined} />
                  Fetch models
                </button>
              </div>
              <HeraldProviderModelsTable providerId={provider.id} models={models} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
