import { useEffect, useRef, useState } from "react";
import type { HeraldByDayRow } from "../../lib/herald-usage.query";

const PAD = { top: 14, right: 56, bottom: 26, left: 52 };
const DEFAULT_W = 960;
const DEFAULT_H = 220;

interface DrawGeometry {
  cssW: number;
  xs: number[];
  tokensY: number[];
}

function cssColor(el: HTMLElement, token: string): string {
  const value = getComputedStyle(el).getPropertyValue(token).trim();
  if (value) return value;
  return getComputedStyle(el).color || "black";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0";
}

function drawChart(canvas: HTMLCanvasElement, rows: HeraldByDayRow[]): DrawGeometry {
  const ctx = canvas.getContext("2d");
  const shell = canvas.parentElement as HTMLElement | null;
  const cssW = shell?.clientWidth || canvas.clientWidth || DEFAULT_W;
  const cssH = shell?.clientHeight || canvas.clientHeight || DEFAULT_H;
  const geometry: DrawGeometry = { cssW, xs: [], tokensY: [] };
  if (!ctx) return geometry;

  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const muted = cssColor(canvas, "--lx-text-muted");
  const grid = cssColor(canvas, "--lx-border-default");
  const cost = cssColor(canvas, "--lx-border-focus");

  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(1, cssW - PAD.left - PAD.right),
    h: Math.max(1, cssH - PAD.top - PAD.bottom),
  };

  const gridLines = 4;
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.font = "10px monospace";
  ctx.fillStyle = muted;
  ctx.textBaseline = "middle";

  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens));
  const maxCost = Math.max(0.000001, ...rows.map((r) => r.costUsd));

  for (let i = 0; i <= gridLines; i++) {
    const t = i / gridLines;
    const y = plot.y + plot.h * t;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(formatTokens(maxTokens * (1 - t)), plot.x - 8, y);
    ctx.textAlign = "left";
    ctx.fillText(formatCost(maxCost * (1 - t)), plot.x + plot.w + 8, y);
  }

  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  const labelCount = Math.min(rows.length, 6);
  for (let i = 0; i < labelCount; i++) {
    const idx = labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (rows.length - 1));
    const row = rows[idx]!;
    const t = rows.length === 1 ? 0.5 : idx / (rows.length - 1);
    ctx.fillText(row.day.slice(5), plot.x + plot.w * t, plot.y + plot.h + 8);
  }

  const xAt = (i: number) => (rows.length === 1 ? plot.x + plot.w / 2 : plot.x + (plot.w * i) / (rows.length - 1));
  const yTokens = (v: number) => plot.y + plot.h - (v / maxTokens) * plot.h;
  const yCost = (v: number) => plot.y + plot.h - (v / maxCost) * plot.h;

  const strokeSeries = (values: number[], yFor: (v: number) => number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = xAt(i);
      const y = yFor(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    values.forEach((v, i) => {
      ctx.beginPath();
      ctx.arc(xAt(i), yFor(v), 2, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  if (rows.length > 0) {
    strokeSeries(rows.map((r) => r.costUsd), yCost, cost);
    strokeSeries(rows.map((r) => r.tokens), yTokens, muted);
    geometry.xs = rows.map((_, i) => xAt(i));
    geometry.tokensY = rows.map((r) => yTokens(r.tokens));
  }

  return geometry;
}

export function UsageChart({
  byDay,
  isLoading,
  isError,
  onRetry,
}: {
  byDay: HeraldByDayRow[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geometryRef = useRef<DrawGeometry | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ row: HeraldByDayRow; x: number; y: number } | null>(null);

  const hasData = byDay && byDay.length > 0;

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    geometryRef.current = drawChart(canvas, byDay);
    setHover(null);
  }, [byDay, size.w, size.h]);

  const handleMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const geometry = geometryRef.current;
    if (!geometry || geometry.xs.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let best = 0;
    let bestDistance = Infinity;
    geometry.xs.forEach((px, i) => {
      const distance = Math.abs(px - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    const row = byDay[best];
    if (!row) return;
    const maxX = Math.max(60, geometry.cssW - 60);
    setHover({ row, x: Math.min(Math.max(geometry.xs[best]!, 60), maxX), y: geometry.tokensY[best] ?? 0 });
  };

  let overlay: string | null = null;
  let showRetry = false;
  if (isLoading) overlay = "Loading chart…";
  else if (isError) {
    overlay = "Failed to load chart";
    showRetry = true;
  } else if (!hasData) overlay = "No data for this window";

  return (
    <section className="card-panel mt-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-base weight-500 color-primary">Usage by day</h2>
      </div>
      <div className="chart-shell" ref={shellRef}>
        <canvas
          ref={canvasRef}
          id="herald-by-day"
          width={DEFAULT_W}
          height={DEFAULT_H}
          aria-label="Tokens and cost per day line chart"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        />
        {overlay ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: showRetry ? "auto" : "none", padding: 12 }}>
            <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", opacity: isLoading ? 0.9 : 0.85, fontStyle: isLoading ? "italic" : undefined }}>
              {overlay}
            </div>
            {showRetry && onRetry ? (
              <button className="btn btn-ghost btn-sm mt-2" style={{ pointerEvents: "auto" }} onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {hover ? (
          <div
            data-testid="herald-chart-tooltip"
            style={{ position: "absolute", left: hover.x, top: hover.y, transform: "translate(-50%, -110%)", pointerEvents: "none", zIndex: 2, background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "6px 8px", boxShadow: "var(--lx-shadow-md)", fontFamily: "var(--lx-font-mono)", fontSize: 11, lineHeight: 1.5, color: "var(--lx-text-primary)", whiteSpace: "nowrap" }}
          >
            <div style={{ fontWeight: 600 }}>{hover.row.day}</div>
            <div>tokens {hover.row.tokens.toLocaleString()}</div>
            <div>cost {formatCost(hover.row.costUsd)}</div>
            <div>latency {hover.row.avgLatencyMs !== null ? `${hover.row.avgLatencyMs.toLocaleString()} ms` : "—"}</div>
            <div>calls {hover.row.calls}</div>
            <div>error_rate {(hover.row.errorRate * 100).toFixed(2)} %</div>
          </div>
        ) : null}
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
