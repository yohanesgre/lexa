import { useMemo } from "react";
import { useHeraldProviders, useHeraldProvidersHealth, useProbeHeraldProvider } from "../../lib/queries/herald-admin";
import type { HeraldProviderHealth } from "../../lib/api";

type Circuit = HeraldProviderHealth["circuitState"];

const badgeClass: Record<Circuit, string> = {
  open: "health-open",
  closed: "health-closed",
  "half-open": "health-half",
};

function worstState(states: (Circuit | undefined)[]): Circuit | null {
  const loaded = states.filter((s): s is Circuit => s !== undefined);
  if (loaded.length === 0) return null;
  if (loaded.includes("open")) return "open";
  if (loaded.includes("half-open")) return "half-open";
  return "closed";
}

export function GatewayHealthSection() {
  const { data: providers, isLoading, isError, refetch } = useHeraldProviders();
  const ids = useMemo(() => (providers ?? []).map((p) => p.id), [providers]);
  const health = useHeraldProvidersHealth(ids);
  const probe = useProbeHeraldProvider();
  const byId = useMemo(() => new Map(health.map((h, i) => [ids[i]!, h])), [health, ids]);
  const settled = health.every((h) => !h.isPending);
  const worst = settled ? worstState(health.map((h) => h.data?.circuitState)) : null;

  return (
    <section className="card-panel mt-4" id="hearth-usage-health">
      <div className="flex items-center justify-between mb-3" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg weight-500 color-primary">Gateway health</h2>
          {worst ? (
            <span className={`health-badge ${badgeClass[worst]}`}>{worst}</span>
          ) : (
            <span className="text-sm color-muted">checking…</span>
          )}
        </div>
      </div>
      <p className="text-sm color-secondary mb-3" style={{ maxWidth: 640 }}>Circuit breaker for the Herald gateway. Probe forces a health check — use after fixing upstream.</p>
      {isLoading ? (
        <div className="text-sm color-muted mt-2">Loading…</div>
      ) : isError ? (
        <div className="card-panel" style={{ borderColor: "var(--lx-text-danger)", background: "var(--lx-bg-danger-subtle)" }}>
          <div className="text-sm" style={{ color: "var(--lx-text-danger)" }}>Failed to load providers</div>
          <button className="btn btn-ghost btn-sm mt-2" onClick={() => refetch()}>Retry</button>
        </div>
      ) : (providers ?? []).length === 0 ? (
        <div className="text-sm color-muted mt-2">No providers configured.</div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
          <table className="settings-table">
            <thead><tr><th>Provider</th><th style={{ width: 100 }}>State</th><th style={{ width: 85, textAlign: "right" }}>failureCount</th><th>openedAt</th><th>lastProbeAt</th><th style={{ width: 80, textAlign: "right" }}></th></tr></thead>
            <tbody>
              {(providers ?? []).map((p) => {
                const h = byId.get(p.id)!;
                const state = h.data?.circuitState;
                return (
                  <tr key={p.id}>
                    <td className="text-sm color-primary">{p.label}</td>
                    <td>
                      {state ? (
                        <span className={`health-badge ${badgeClass[state]}`}>{state}</span>
                      ) : h.isError ? (
                        <span className="text-sm" style={{ color: "var(--lx-text-danger)" }}>error</span>
                      ) : (
                        <span className="text-sm color-muted">…</span>
                      )}
                    </td>
                    <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>
                      {h.data ? h.data.failureCount : "—"}
                    </td>
                    <td className="font-mono text-xs color-muted">{h.data?.openedAt ?? "—"}</td>
                    <td className="font-mono text-xs color-secondary">{h.data?.lastProbeAt ?? "—"}</td>
                    <td style={{ textAlign: "right" }}><button className={state === "open" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"} disabled={probe.isPending} title="Run live upstream test and update breaker state" onClick={() => probe.mutate(p.id)}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7" /><path d="M21 3v6h-6" /></svg> {probe.isPending && probe.variables === p.id ? "Probing…" : "Probe"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
