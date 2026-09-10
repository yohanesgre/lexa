import type { HeraldByModelRow, HeraldUsageSummary } from "../../lib/herald-usage.query";

function errorColor(rate: number): string {
  if (rate > 0.05) return "var(--lx-text-danger)";
  if (rate > 0.01) return "var(--lx-text-warning)";
  return "var(--lx-text-success)";
}

function LoadingRow() {
  return (
    <tr>
      <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
        <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic", marginBottom: 8 }}>Loading usage…</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 360, margin: "0 auto" }}>
          <div style={{ height: 8, borderRadius: 4, background: "var(--lx-bg-subtle)", opacity: 0.9, animation: "pulse 1.2s ease-in-out infinite" }} />
          <div style={{ height: 8, borderRadius: 4, background: "var(--lx-bg-subtle)", opacity: 0.6, width: "85%", margin: "0 auto", animation: "pulse 1.2s ease-in-out infinite" }} />
        </div>
      </td>
    </tr>
  );
}

function ErrorRow({ onRetry }: { onRetry?: (() => void) | undefined }) {
  return (
    <tr>
      <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
        <span className="font-mono text-xs" style={{ color: "var(--lx-text-danger)", fontStyle: "italic" }}>Failed to load usage</span>
        {onRetry ? (
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 10, verticalAlign: "middle" }} onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ModelRow({ row }: { row: HeraldByModelRow }) {
  const zeroCalls = row.calls === 0;
  if (zeroCalls) {
    return (
      <tr>
        <td className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>{row.model}</td>
        <td className="font-mono text-xs color-muted" style={{ textAlign: "right" }}>—</td>
        <td className="font-mono text-xs color-muted" style={{ textAlign: "right" }}>—</td>
        <td className="font-mono text-xs color-muted" style={{ textAlign: "right" }}>—</td>
        <td className="font-mono text-xs color-muted" style={{ textAlign: "right" }}>0</td>
        <td style={{ textAlign: "right" }}>
          <span className="font-mono text-xs color-muted">—</span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className="font-mono text-xs weight-500 color-primary">{row.model}</td>
      <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>{row.tokens.toLocaleString()}</td>
      <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>${row.costUsd.toFixed(2)}</td>
      <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{row.avgLatencyMs !== null ? `${row.avgLatencyMs} ms` : "—"}</td>
      <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{row.calls}</td>
      <td style={{ textAlign: "right" }}>
        <span className="font-mono text-xs" style={{ color: errorColor(row.errorRate) }}>{(row.errorRate * 100).toFixed(1)}%</span>
      </td>
    </tr>
  );
}

function EmptyRow({ showHint, hasFilters, onRetry }: { showHint: boolean; hasFilters: boolean; onRetry?: (() => void) | undefined }) {
  return (
    <tr>
      <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
        <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No usage for this window</div>
        {hasFilters ? (
          onRetry ? (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={onRetry}>
              Clear filters
            </button>
          ) : (
            <div className="font-micro text-2xs color-muted" style={{ marginTop: 4 }}>Try clearing filters</div>
          )
        ) : showHint ? (
          <div className="font-micro text-2xs color-muted" style={{ marginTop: 4 }}>No gateway calls recorded yet — Send first Herald request</div>
        ) : null}
      </td>
    </tr>
  );
}

type TableState = "loading" | "error" | "data" | "empty";

function TableBody({ state, byModel, showHint, hasFilters, onRetry }: {
  state: TableState;
  byModel: HeraldByModelRow[];
  showHint: boolean;
  hasFilters: boolean;
  onRetry?: (() => void) | undefined;
}) {
  if (state === "loading") return <LoadingRow />;
  if (state === "error") return <ErrorRow onRetry={onRetry} />;
  if (state === "data") {
    const sorted = [...byModel].sort((a, b) => b.tokens - a.tokens);
    return <>{sorted.map((r) => <ModelRow key={r.model} row={r} />)}</>;
  }
  return <EmptyRow showHint={showHint} hasFilters={hasFilters} onRetry={onRetry} />;
}

export function UsageByModelTable({
  byModel,
  isLoading,
  isError,
  onRetry,
  summary,
  filters,
}: {
  byModel: HeraldByModelRow[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  summary?: HeraldUsageSummary | null;
  filters?: { from?: string | null | undefined; to?: string | null | undefined };
}) {
  const hasFilters = !!(filters?.from || filters?.to);
  return (
    <section className="card-panel mt-4" style={{ overflow: "hidden", padding: 0 }}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="font-display text-base weight-500 color-primary">Usage by model</h2>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="settings-table settings-table--herald-usage" style={{ width: "100%", tableLayout: "fixed" as const }}>
          <thead>
            <tr>
              <th style={{ width: "auto" }}>Model</th>
              <th style={{ width: 110, textAlign: "right", whiteSpace: "nowrap" as const }}>Tokens</th>
              <th style={{ width: 110, textAlign: "right", whiteSpace: "nowrap" as const }}>Cost</th>
              <th style={{ width: 110, textAlign: "right", whiteSpace: "nowrap" as const }}>Avg latency</th>
              <th style={{ width: 80, textAlign: "right", whiteSpace: "nowrap" as const }}>Calls</th>
              <th style={{ width: 90, textAlign: "right", whiteSpace: "nowrap" as const }}>Error rate</th>
            </tr>
          </thead>
          <tbody>
            <TableBody
              state={isLoading ? "loading" : isError ? "error" : byModel && byModel.length > 0 ? "data" : "empty"}
              byModel={byModel}
              showHint={summary?.totalCalls === 0}
              hasFilters={hasFilters}
              onRetry={onRetry}
            />
          </tbody>
        </table>
      </div>
    </section>
  );
}
