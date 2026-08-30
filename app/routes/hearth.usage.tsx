import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useHearthRole } from "../lib/useHearthRole";
import { useToast } from "../components/ui/Toast";
import { useHeraldUsage, exportHeraldUsageCsv } from "../lib/herald-usage.query";
import { UsageKpiCards } from "../components/herald/UsageKpiCards";
import { UsageChart } from "../components/herald/UsageChart";
import { UsageByModelTable } from "../components/herald/UsageByModelTable";
import { PriceEditor } from "../components/herald/PriceEditor";

export const Route = createFileRoute("/hearth/usage")({
  validateSearch: (search: Record<string, unknown>): { from?: string | undefined; to?: string | undefined } => ({
    from: typeof search.from === "string" && search.from ? search.from : undefined,
    to: typeof search.to === "string" && search.to ? search.to : undefined,
  }),
  ssr: false,
  component: HearthUsageRoute,
});

function HearthUsageRoute() {
  const { canViewUsage, isLoading } = useHearthRole();
  const toast = useToast();

  const search = Route.useSearch() as { from?: string | undefined; to?: string | undefined };
  const [from, setFrom] = useState(search.from ?? "");
  const [to, setTo] = useState(search.to ?? "");
  const [filters, setFilters] = useState<{ from?: string | null; to?: string | null }>({ from: search.from ?? null, to: search.to ?? null });

  const { data, isLoading: usageLoading, error, refetch } = useHeraldUsage(filters);

  useEffect(() => {
    setFrom(search.from ?? "");
    setTo(search.to ?? "");
    setFilters({ from: search.from ?? null, to: search.to ?? null });
  }, [search.from, search.to]);

  useEffect(() => {
    if (!isLoading && !canViewUsage) {
      toast.push("warning", "You don't have access");
    }
  }, [isLoading, canViewUsage, toast]);

  if (isLoading) return null;
  if (!canViewUsage) {
    return <Navigate to="/hearth/runs" replace />;
  }

  const handleApply = () => setFilters({ from: from || null, to: to || null });
  const handleExport = async () => {
    await exportHeraldUsageCsv({ from: from || null, to: to || null });
  };

  return (
    <section className="mt-4">
      {error ? (
        <div className="card-panel" style={{ borderColor: "var(--lx-text-danger)", background: "var(--lx-bg-danger-subtle)" }}>
          <div className="text-sm" style={{ color: "var(--lx-text-danger)" }}>{(error as Error).message}</div>
        </div>
      ) : null}

      {usageLoading ? <div className="text-sm color-muted mt-2">Loading…</div> : <UsageKpiCards summary={data?.summary} />}

      <section className="card-panel mt-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-base weight-500 color-primary">Filters</h2>
        </div>
        <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="hearth-usage-from" className="field-label" style={{ marginBottom: 4 }}>From</label>
            <input id="hearth-usage-from" aria-label="From date" className="prop-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="hearth-usage-to" className="field-label" style={{ marginBottom: 4 }}>To</label>
            <input id="hearth-usage-to" aria-label="To date" className="prop-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
          </div>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-end" }} onClick={handleApply}>Apply</button>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-end" }}>
            <button className="btn btn-ghost btn-sm" onClick={handleExport}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1={12} y1={15} x2={12} y2={3} /></svg>
              Export CSV
            </button>
          </div>
        </div>
      </section>

      <div className="mt-4" style={{ height: 220 }}>
        <UsageChart byDay={data?.byDay ?? []} isLoading={usageLoading} isError={!!error} onRetry={() => refetch()} />
      </div>

      <UsageByModelTable byModel={data?.byModel ?? []} isLoading={usageLoading} isError={!!error} onRetry={() => refetch()} summary={data?.summary ?? null} filters={filters} />

      <PriceEditor byModel={data?.byModel ?? []} isLoadingUsage={usageLoading} isErrorUsage={!!error} />

      <section className="card-panel mt-4" id="hearth-usage-health">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg weight-500 color-primary">Gateway health</h2>
            <span className="health-badge health-closed">closed</span>
          </div>
        </div>
        <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>Circuit breaker for the Herald gateway. Probe forces a health check — use after fixing upstream.</p>
        <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
          <table className="settings-table">
            <thead><tr><th style={{ width: 100 }}>State</th><th style={{ width: 85, textAlign: "right" }}>failureCount</th><th>openedAt</th><th>lastProbeAt</th><th style={{ width: 80, textAlign: "right" }}></th></tr></thead>
            <tbody>
              <tr><td><span className="health-badge health-closed">closed</span></td><td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>0</td><td className="font-mono text-xs color-muted">—</td><td className="font-mono text-xs color-secondary">—</td><td style={{ textAlign: "right" }}><button className="btn btn-ghost btn-sm" disabled title="Health probe (circuit breaker) — manual probe via POST /api/admin/herald/health/probe when breaker open"><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg> Probe</button></td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
