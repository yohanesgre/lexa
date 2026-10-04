import { useState } from "react";
import { useAssistantPrices, usePutAssistantPrice, type AssistantPriceRow } from "../../lib/assistant-usage.query";
import type { AssistantByModelRow } from "../../lib/assistant-usage.query";
import { PriceSyncButton } from "./admin/PriceSyncButton";

interface PriceEdit {
  prompt_price: string;
  completion_price: string;
  cached_read_price: string;
  cached_write_price: string;
  error?: string | undefined;
}

const PRICE_ERROR = "Enter a price ≥ 0, no exponent, max 6 decimals";

// The raw string is validated, never Number()'s coercion: blank, exponent
// notation ("1e3"), negative, non-finite and >6-decimal inputs are rejected
// before they can reach the PUT.
function parsePrice(raw: string): number | null {
  const s = raw.trim();
  if (!s || /[eE]/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const dot = s.indexOf(".");
  if (dot !== -1 && s.slice(dot + 1).length > 6) return null;
  return n;
}

export function PriceEditor({
  byModel,
  isLoadingUsage,
  isErrorUsage,
}: {
  byModel?: AssistantByModelRow[];
  isLoadingUsage?: boolean;
  isErrorUsage?: boolean;
}) {
  const { data: priceData, isLoading: isLoadingPrices, isError: isErrorPrices } = useAssistantPrices();
  const putPrice = usePutAssistantPrice();
  const [edits, setEdits] = useState<Record<string, PriceEdit>>({});

  const prices: AssistantPriceRow[] = (priceData as unknown as { data: AssistantPriceRow[] })?.data ?? (priceData as unknown as AssistantPriceRow[]) ?? [];
  const priceMap = new Map(prices.map((p) => [p.model, p]));
  const models = (() => {
    const set = new Set<string>();
    for (const p of prices) set.add(p.model);
    for (const m of byModel ?? []) set.add(m.model);
    return Array.from(set).sort();
  })();

  // Missing rows stay blank, never "0": a blank forces the user to enter an
  // explicit price instead of silently persisting a zero over an unknown model.
  const defaultsFor = (model: string): PriceEdit => {
    const p = priceMap.get(model);
    return {
      prompt_price: p ? String(p.prompt_price) : "",
      completion_price: p ? String(p.completion_price) : "",
      cached_read_price: p ? String(p.cached_read_price) : "",
      cached_write_price: p ? String(p.cached_write_price) : "",
    };
  };

  const handleSave = (model: string) => {
    if (isErrorPrices) return;
    const e = edits[model] ?? defaultsFor(model);
    const pp = parsePrice(e.prompt_price);
    const cp = parsePrice(e.completion_price);
    const cr = parsePrice(e.cached_read_price);
    const cw = parsePrice(e.cached_write_price);
    if (pp === null || cp === null || cr === null || cw === null) {
      setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), error: PRICE_ERROR } }));
      return;
    }
    setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), error: undefined } }));
    putPrice.mutate({ model, prompt_price: pp, completion_price: cp, cached_read_price: cr, cached_write_price: cw });
  };

  const handleReset = (model: string) => setEdits((prev) => ({ ...prev, [model]: defaultsFor(model) }));

  const isLoading = isLoadingPrices || !!isLoadingUsage;
  const isError = isErrorPrices || !!isErrorUsage;
  const pricesErrored = isErrorPrices;

  if (isError && prices.length === 0 && models.length === 0) {
    return (
      <section className="card-panel card-panel--elevated mt-4">
        <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2 className="font-display text-base weight-500 color-primary">Model prices</h2>
          <PriceSyncButton />
        </div>
        <div className="text-sm" style={{ color: "var(--lx-text-danger)" }}>Failed to load prices</div>
      </section>
    );
  }

  return (
    <section className="card-panel card-panel--elevated mt-4">
      <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 className="font-display text-base weight-500 color-primary">Model prices</h2>
        <PriceSyncButton />
      </div>
      <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>
        Per-model per-token prices used to derive cost in the summary and per-model table. Prices are stored as USD per 1M tokens (input / output / cached read / cached write). Editing writes immediately; new prices apply to future usage.
      </p>
      {isError ? <div className="text-sm mb-2" style={{ color: "var(--lx-text-danger)" }}>Failed to load prices</div> : null}
      <div style={{ overflowX: "auto" }}>
        <table className="settings-table settings-table--assistant-prices">
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
            {isLoading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>Loading prices…</div>
                </td>
              </tr>
            ) : models.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No models yet</div>
                  <div className="font-micro text-2xs color-muted" style={{ marginTop: 4 }}>Prices appear after the first gateway call. Save to add one manually.</div>
                </td>
              </tr>
            ) : models.map((model) => {
              const e = edits[model] ?? defaultsFor(model);
              const modelPending = putPrice.isPending && putPrice.variables?.model === model;
              const serverError = putPrice.isError && putPrice.variables?.model === model ? (putPrice.error as Error).message : null;
              const setField = (field: keyof Omit<PriceEdit, "error">) => (ev: React.ChangeEvent<HTMLInputElement>) => {
                const value = ev.target.value;
                setEdits((prev) => ({ ...prev, [model]: { ...(prev[model] ?? defaultsFor(model)), [field]: value } }));
              };
              return (
                <tr key={model}>
                  <td className="font-mono text-xs weight-500 color-primary">{model}</td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`prompt_price for ${model}`} value={e.prompt_price} onChange={setField("prompt_price")} readOnly={pricesErrored} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`completion_price for ${model}`} value={e.completion_price} onChange={setField("completion_price")} readOnly={pricesErrored} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`cached_read_price for ${model}`} value={e.cached_read_price} onChange={setField("cached_read_price")} readOnly={pricesErrored} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td>
                    <input className="prop-input font-mono" aria-label={`cached_write_price for ${model}`} value={e.cached_write_price} onChange={setField("cached_write_price")} readOnly={pricesErrored} style={{ width: 120, height: 28, fontSize: 12, textAlign: "right" }} />
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => handleSave(model)} disabled={pricesErrored || modelPending}>{modelPending ? "Saving…" : "Save"}</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleReset(model)} disabled={pricesErrored} style={{ marginLeft: 6 }}>Reset</button>
                    {e.error ? <div className="font-micro text-2xs" style={{ color: "var(--lx-text-danger)", marginTop: 4 }}>{e.error}</div> : null}
                    {serverError ? <div className="font-micro text-2xs" style={{ color: "var(--lx-text-danger)", marginTop: 4 }}>{serverError}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-panel mt-3" style={{ background: "var(--lx-bg-accent-subtle)", borderColor: "color-mix(in srgb, var(--lx-text-link) 18%, transparent)", padding: "12px 14px" }}>
        <div className="flex items-center gap-2">
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-warning)" strokeWidth={1.5}><circle cx={12} cy={12} r={10} /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
          <span className="text-sm weight-500" style={{ color: "var(--lx-text-warning)" }}>Price change affects future cost only — past usage keeps the price it was recorded with.</span>
        </div>
      </div>
    </section>
  );
}
