import type { HeraldUsageSummary } from "../../lib/herald-usage.query";

export function UsageKpiCards({ summary }: { summary: HeraldUsageSummary | null | undefined }) {
  if (!summary) {
    return (
      <div className="kpi-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="kpi-label" style={{ opacity: 0.5 }}>—</div>
            <div className="kpi-value">—</div>
          </div>
        ))}
      </div>
    );
  }
  const errorPct = (summary.errorRate * 100).toFixed(1);
  const errorClass = summary.errorRate > 0.05 ? "kpi-value-danger" : summary.errorRate > 0 ? "kpi-value-warning" : "";
  return (
    <div className="kpi-grid">
      <div className="kpi-card">
        <div className="kpi-label">Total tokens</div>
        <div className="kpi-value">{summary.totalTokens.toLocaleString()}</div>
        <div className="text-xs color-muted mt-1" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, letterSpacing: "0.02em" }}>
          prompt {summary.promptTokens.toLocaleString()} · completion {summary.completionTokens.toLocaleString()}
        </div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Cost</div>
        <div className="kpi-value">${summary.totalCostUsd.toFixed(2)}</div>
        <div className="text-xs color-muted mt-1" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, letterSpacing: "0.02em" }}>
          USD · derived from model prices
        </div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Avg latency</div>
        <div className="kpi-value">{summary.avgLatencyMs !== null ? `${summary.avgLatencyMs.toLocaleString()} ms` : "—"}</div>
        <div className="text-xs color-muted mt-1" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, letterSpacing: "0.02em" }}>
          p50 — · p95 — ms
        </div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">Error rate</div>
        <div className={`kpi-value ${errorClass}`}>{errorPct} %</div>
        <div className="text-xs color-muted mt-1" style={{ fontFamily: "var(--lx-font-micro)", fontSize: 11, letterSpacing: "0.02em" }}>
          {summary.errorCalls} / {summary.totalCalls} calls
        </div>
      </div>
    </div>
  );
}
