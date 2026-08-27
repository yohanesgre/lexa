import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useHeraldUsage, exportHeraldUsageCsv } from "../lib/herald-usage.query";
import { UsageKpiCards } from "../components/herald/UsageKpiCards";
import { UsageChart } from "../components/herald/UsageChart";
import { UsageByModelTable } from "../components/herald/UsageByModelTable";
import { PriceEditor } from "../components/herald/PriceEditor";

export const Route = createFileRoute("/admin/herald/usage")({
  component: HeraldUsagePage,
});

function HeraldUsagePage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState<{ from?: string | null | undefined; to?: string | null }>({});
  const { data, isLoading, error } = useHeraldUsage(filters);

  const handleApply = () => setFilters({ from: from || null, to: to || null });

  const handleExport = async () => {
    await exportHeraldUsageCsv({ from: from || null, to: to || null });
  };

  return (
    <main className="page-frame">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-display text-2xl weight-600 color-primary">Herald Usage</h1>
          <div className="font-micro text-2xs color-muted mt-1" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Admin · gateway usage, cost, latency &amp; health · all projects aggregated
          </div>
        </div>
        <Link to="/" className="btn btn-ghost text-sm">Back to index</Link>
      </div>

      {error ? (
        <div className="card-panel" style={{ borderColor: "var(--lx-text-danger)", background: "var(--lx-bg-danger-subtle)" }}>
          <div className="text-sm" style={{ color: "var(--lx-text-danger)" }}>{(error as Error).message}</div>
        </div>
      ) : null}

      {isLoading ? <div className="text-sm color-muted mt-2">Loading…</div> : <UsageKpiCards summary={data?.summary} />}

      <section className="card-panel mt-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-base weight-500 color-primary">Filters</h2>
        </div>
        <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" style={{ marginBottom: 4 }}>From</label>
            <input className="prop-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" style={{ marginBottom: 4 }}>To</label>
            <input className="prop-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
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

      <UsageChart byDay={data?.byDay ?? []} />

      <UsageByModelTable byModel={data?.byModel ?? []} />

      <PriceEditor byModel={data?.byModel!} />

      <section className="card-panel mt-4" id="health">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-lg weight-500 color-primary">Gateway health</h2>
            <span className="health-badge health-closed">closed</span>
          </div>
        </div>
        <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>
          Circuit breaker for the Herald gateway. Failures trip the breaker; half-open probes recovery. Probe forces a health check — use after fixing the upstream.
        </p>
        <div className="flex items-center gap-2 mb-3" style={{ flexWrap: "wrap" }}>
          <span className="health-badge health-open">open</span>
          <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>red · breaker tripped — gateway rejecting calls</span>
          <span className="health-badge health-half" style={{ marginLeft: 12 }}>half-open</span>
          <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>amber · probing recovery</span>
          <span className="health-badge health-closed" style={{ marginLeft: 12 }}>closed</span>
          <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>green · healthy</span>
        </div>
        <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th style={{ width: 120 }}>State</th>
                <th style={{ width: 110, textAlign: "right" }}>failureCount</th>
                <th style={{ width: "auto" }}>openedAt</th>
                <th style={{ width: "auto" }}>lastProbeAt</th>
                <th style={{ width: 120, textAlign: "right" }}></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="health-badge health-closed">closed</span></td>
                <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>0</td>
                <td className="font-mono text-xs color-muted">—</td>
                <td className="font-mono text-xs color-secondary">—</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn btn-ghost btn-sm">
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg>
                    Probe
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
