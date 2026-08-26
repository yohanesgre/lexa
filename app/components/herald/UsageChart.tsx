import type { HeraldByDayRow } from "../../lib/herald-usage.query";

export function UsageChart({ byDay }: { byDay: HeraldByDayRow[] }) {
  const hasData = byDay && byDay.length > 0;
  return (
    <section className="card-panel mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-base weight-500 color-primary">Usage by day</h2>
      </div>
      <div className="chart-shell">
        <canvas id="herald-by-day" width={960} height={220} aria-label="Tokens per day line chart placeholder" />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <svg width={40} height={20} viewBox="0 0 100 24" fill="none" style={{ opacity: 0.35, marginBottom: 8 }}>
            <path d="M2 18 L20 14 L38 16 L56 8 L74 10 L92 4" stroke="var(--lx-text-muted)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx={20} cy={14} r={2} fill="var(--lx-text-muted)" />
            <circle cx={56} cy={8} r={2} fill="var(--lx-text-muted)" />
            <circle cx={92} cy={4} r={2} fill="var(--lx-border-focus)" />
          </svg>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Line chart — tokens / cost / latency per day
          </div>
          <div className="font-micro text-2xs color-muted" style={{ opacity: 0.7 }}>
            {hasData ? `${byDay.length} day(s)` : "No data for this window"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3" style={{ flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)" }}>
          <span style={{ width: 10, height: 3, background: "var(--lx-text-muted)", borderRadius: 2, display: "inline-block" }} />
          tokens
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--lx-font-micro)", fontSize: 11, color: "var(--lx-text-muted)" }}>
          <span style={{ width: 10, height: 3, background: "var(--lx-border-focus)", borderRadius: 2, display: "inline-block" }} />
          cost
        </span>
        <span className="font-micro text-2xs color-muted" style={{ marginLeft: 8 }}>
          Hover shows day tooltip: tokens · cost · latency · calls · error_rate
        </span>
      </div>
    </section>
  );
}
