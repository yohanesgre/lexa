import { useState } from "react";
import { useHeraldPrices, usePutHeraldPrice, type HeraldPriceRow } from "../../lib/herald-usage.query";
import type { HeraldByModelRow } from "../../lib/herald-usage.query";

interface PriceEdit {
  prompt_price: string;
  completion_price: string;
  cached_read_price: string;
  cached_write_price: string;
  error?: string | undefined;
}

export function PriceEditor({
  byModel,
  isLoadingUsage,
  isErrorUsage,
}: {
  byModel?: HeraldByModelRow[];
  isLoadingUsage?: boolean;
  isErrorUsage?: boolean;
}) {
  const { data: priceData, isLoading: isLoadingPrices, isError: isErrorPrices } = useHeraldPrices();
  const putPrice = usePutHeraldPrice();
  const [edits, setEdits] = useState<Record<string, PriceEdit>>({});

  const prices: HeraldPriceRow[] = (priceData as unknown as { data: HeraldPriceRow[] })?.data ?? (priceData as unknown as HeraldPriceRow[]) ?? [];
  const priceMap = new Map(prices.map((p) => [p.model, p]));
  const models = (() => {
    const set = new Set<string>();
    for (const p of prices) set.add(p.model);
    for (const m of byModel ?? []) set.add(m.model);
    return Array.from(set).sort();
  })();

  const defaultsFor = (model: string): PriceEdit => {
    const p = priceMap.get(model);
    return {
      prompt_price: p ? String(p.prompt_price) : "0",
      completion_price: p ? String(p.completion_price) : "0",
      cached_read_price: p ? String(p.cached_read_price) : "0",
      cached_write_price: p ? String(p.cached_write_price) : "0",
    };
  };

  const handleSave = (model: string) => {
    const e = edits[model] ?? defaultsFor(model);
    const pp = Number(e.prompt_price);
    const cp = Number(e.completion_price);
    const cr = Number(e.cached_read_price);
    const cw = Number(e.cached_write_price);
    const decimalsOk = (n: number) => {
      const s = String(n);
      const dot = s.indexOf(".");
      if (dot === -1) return true;
      return s.slice(dot + 1).length <= 6;
    };
    const valid = (n: number) => Number.isFinite(n) && n >= 0 && decimalsOk(n);
    if (!valid(pp) || !valid(cp) || !valid(cr) || !valid(cw)) {
      setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), error: "Invalid number (≥0, max 6 decimals)" } }));
      return;
    }
    setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), error: undefined } }));
    putPrice.mutate({ model, prompt_price: pp, completion_price: cp, cached_read_price: cr, cached_write_price: cw });
  };

  const handleReset = (model: string) => {
    const p = priceMap.get(model);
    setEdits((prev) => ({
      ...prev,
      [model]: {
        prompt_price: p ? String(p.prompt_price) : "0",
        completion_price: p ? String(p.completion_price) : "0",
        cached_read_price: p ? String(p.cached_read_price) : "0",
        cached_write_price: p ? String(p.cached_write_price) : "0",
        error: undefined,
      },
    }));
  };

  const isLoading = isLoadingPrices || !!isLoadingUsage;
  const isError = isErrorPrices || !!isErrorUsage;

  if (isLoading) return <div className="card-panel card-panel--elevated mt-4"><div className="text-sm color-muted">Loading prices…</div></div>;

  if (isError && prices.length === 0 && models.length === 0) {
    return (
      <section className="card-panel card-panel--elevated mt-4">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2 className="font-display text-base weight-500 color-primary">Model prices</h2>
        </div>
        <div className="text-sm" style={{ color: "var(--lx-text-danger)" }}>Failed to load prices</div>
      </section>
    );
  }

  return (
    <section className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 className="font-display text-base weight-500 color-primary">Model prices</h2>
      </div>
      <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>
        Per-model per-token prices used to derive cost in the summary and by_model table. Prices are stored as USD per 1M tokens (input / output / cached read / cached write). Editing writes immediately; cost is recomputed on the next usage fetch.
      </p>
      {isError ? <div className="text-sm mb-2" style={{ color: "var(--lx-text-danger)" }}>Failed to load prices</div> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: "auto" }}>Model</th>
              <th style={{ width: 130 }}>input <span className="font-micro text-2xs color-muted" style={{ textTransform: "none", letterSpacing: 0 }}>$/1M</span></th>
              <th style={{ width: 130 }}>output <span className="font-micro text-2xs color-muted" style={{ textTransform: "none", letterSpacing: 0 }}>$/1M</span></th>
              <th style={{ width: 130 }}>cached read <span className="font-micro text-2xs color-muted" style={{ textTransform: "none", letterSpacing: 0 }}>$/1M</span></th>
              <th style={{ width: 130 }}>cached write <span className="font-micro text-2xs color-muted" style={{ textTransform: "none", letterSpacing: 0 }}>$/1M</span></th>
              <th style={{ width: 120, textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No models yet</div>
                  <div className="font-micro text-2xs color-muted" style={{ marginTop: 4 }}>Prices appear after first gateway call. Add manually via Save (PUT creates row)</div>
                </td>
              </tr>
            ) : models.map((model) => {
              const e = edits[model] ?? defaultsFor(model);
              const setField = (field: keyof Omit<PriceEdit, "error">) => (ev: React.ChangeEvent<HTMLInputElement>) => {
                const value = ev.target.value;
                setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), [field]: value } }));
              };
              return (
                <tr key={model}>
                  <td className="font-mono text-xs weight-500 color-primary">{model}</td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`prompt_price for ${model}`} value={e.prompt_price} onChange={setField("prompt_price")} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`completion_price for ${model}`} value={e.completion_price} onChange={setField("completion_price")} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`cached_read_price for ${model}`} value={e.cached_read_price} onChange={setField("cached_read_price")} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`cached_write_price for ${model}`} value={e.cached_write_price} onChange={setField("cached_write_price")} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-primary btn-sm" onClick={() => handleSave(model)} disabled={putPrice.isPending}>Save</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleReset(model)} style={{ marginLeft: 6 }}>Reset</button>
                    {e.error ? <div className="font-micro text-2xs" style={{ color: "var(--lx-text-danger)", marginTop: 4 }}>{e.error}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-panel mt-3" style={{ background: "var(--lx-bg-accent-subtle)", borderColor: "rgba(240,192,64,0.18)", padding: "12px 14px" }}>
        <div className="flex items-center gap-2">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-warning)" strokeWidth={1.5}><circle cx={12} cy={12} r={10} /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
          <span className="text-sm weight-500" style={{ color: "var(--lx-text-warning)" }}>Price change affects future cost only — past by_day rows keep the price that was active when they were recorded.</span>
        </div>
      </div>
    </section>
  );
}
