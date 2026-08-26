import type { HeraldByModelRow } from "../../lib/herald-usage.query";

function errorColor(rate: number): string {
  if (rate > 0.05) return "var(--lx-text-danger)";
  if (rate > 0.01) return "var(--lx-text-warning)";
  return "var(--lx-text-success)";
}

export function UsageByModelTable({ byModel }: { byModel: HeraldByModelRow[] }) {
  const hasData = byModel && byModel.length > 0;
  return (
    <section className="card-panel mt-4" style={{ overflow: "hidden", padding: 0 }}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="font-display text-base weight-500 color-primary">Usage by model</h2>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: "auto" }}>Model</th>
              <th style={{ width: 110, textAlign: "right" }}>Tokens</th>
              <th style={{ width: 110, textAlign: "right" }}>Cost</th>
              <th style={{ width: 110, textAlign: "right" }}>Avg latency</th>
              <th style={{ width: 80, textAlign: "right" }}>Calls</th>
              <th style={{ width: 90, textAlign: "right" }}>Error rate</th>
            </tr>
          </thead>
          <tbody>
            {hasData ? (
              byModel.map((r) => (
                <tr key={r.model}>
                  <td className="font-mono text-xs weight-500 color-primary">{r.model}</td>
                  <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>{r.tokens.toLocaleString()}</td>
                  <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>${r.costUsd.toFixed(2)}</td>
                  <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{r.avgLatencyMs !== null ? `${r.avgLatencyMs} ms` : "—"}</td>
                  <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{r.calls}</td>
                  <td style={{ textAlign: "right" }}>
                    <span className="font-mono text-xs" style={{ color: errorColor(r.errorRate) }}>{(r.errorRate * 100).toFixed(1)}%</span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="font-mono text-xs color-muted" colSpan={6} style={{ textAlign: "center", fontStyle: "italic" }}>No usage for this window</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
