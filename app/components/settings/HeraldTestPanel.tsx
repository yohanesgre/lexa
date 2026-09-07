import type { HeraldProviderModel } from "../../../shared/herald";

type FallbackRow = HeraldProviderModel & { providerLabel: string; providerId: string };

// "Test connection" in-flight panel: minimal completion ping progress with
// the fallback chain queued below the primary attempt.
export function HeraldTestPanel({
  total,
  primaryLabel,
  providerLabel,
  fallbackRows,
}: {
  total: number;
  primaryLabel: string;
  providerLabel: string;
  fallbackRows: FallbackRow[];
}) {
  const pct = total > 1 ? Math.round(100 / total) : 100;
  return (
    <div className="card-panel card-panel--neutral" style={{ marginTop: 10, padding: "10px 12px" }}>
      <div className="flex items-center gap-2">
        <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
        <span className="text-xs font-medium text-lx-text-primary">Testing… attempt 1/{total}</span>
        <span className="font-micro text-2xs text-lx-text-muted" style={{ marginLeft: "auto", textTransform: "uppercase", letterSpacing: "0.04em" }}>{primaryLabel} · {providerLabel}</span>
      </div>
      <div style={{ marginTop: 8, height: 4, background: "var(--lx-surface-card)", borderRadius: 9999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--lx-border-focus)", transition: "width 300ms" }} />
      </div>
      <div className="text-xs text-lx-text-secondary mt-1 font-mono" style={{ fontSize: 11 }}>Minimal completion ping (+ Exa ping when set)</div>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="flex items-center gap-2">
          <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
          <span className="font-mono text-xs text-lx-text-primary">{primaryLabel}</span>
          <span className="font-mono text-2xs text-lx-text-muted">trying…</span>
        </div>
        {fallbackRows.map((row) => (
          <div key={`${row.providerId}:${row.modelId}`} className="flex items-center gap-2" style={{ opacity: 0.6 }}>
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-muted)" strokeWidth={2}><circle cx={12} cy={12} r={10} /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
            <span className="font-mono text-xs text-lx-text-muted">{row.modelId}</span>
            <span className="font-mono text-2xs text-lx-text-muted">queued (fallback)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
