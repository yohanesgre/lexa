import { useAssistantCalls } from "../../../lib/queries/assistant-admin";
import { formatTimestamp } from "./run-display";

// Raw per-call log rows (assistant_call_logs), distinct from runs
// (assistant_tasks): one row per provider call including retries/fallbacks.
// Read-only — surfaces useAssistantCalls + GET /api/admin/assistant/calls.
interface CallRow {
  id: string;
  model: string;
  status: string;
  latencyMs: number | null;
  usageIn: number;
  usageOut: number;
  costCents: number;
  errorCode: string | null;
  createdAt: string;
}

export function AssistantCallsTable() {
  const { data, isLoading, isError, refetch } = useAssistantCalls({ limit: 50 });
  const rows = (data ?? []) as unknown as CallRow[];

  return (
    <section className="card-panel mt-4" style={{ overflow: "hidden", padding: 0 }}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 className="font-display text-base weight-500 color-primary">Recent calls</h2>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: 120 }}>Time</th>
              <th style={{ width: "auto" }}>Model</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 100, textAlign: "right" }}>Latency</th>
              <th style={{ width: 90, textAlign: "right" }}>Tokens</th>
              <th style={{ width: 90, textAlign: "right" }}>Cost</th>
              <th style={{ width: 160 }}>Error code</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>Loading calls…</div>
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs" style={{ color: "var(--lx-text-danger)" }}>Failed to load calls.</div>
                  <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => refetch()}>Retry</button>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No calls yet</div>
                </td>
              </tr>
            ) : rows.map((c) => {
              const ok = c.status === "done";
              const tokens = (c.usageIn ?? 0) + (c.usageOut ?? 0);
              return (
                <tr key={c.id}>
                  <td className="font-mono text-xs color-secondary">{formatTimestamp(c.createdAt)}</td>
                  <td className="font-mono text-xs color-primary">{c.model}</td>
                  <td>
                    <span className="status-chip" style={{ cursor: "default" }}>
                      <span className="status-dot" style={{ background: ok ? "var(--lx-text-success)" : "var(--lx-text-danger)" }} />
                      {ok ? "ok" : "error"}
                    </span>
                  </td>
                  <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{c.latencyMs != null ? `${c.latencyMs.toLocaleString()} ms` : "—"}</td>
                  <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{tokens.toLocaleString()}</td>
                  <td className="font-mono text-xs color-primary" style={{ textAlign: "right" }}>${((c.costCents ?? 0) / 100).toFixed(3)}</td>
                  <td className="font-mono text-xs" style={{ color: c.errorCode ? "var(--lx-text-danger)" : "var(--lx-text-muted)" }}>{c.errorCode ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
