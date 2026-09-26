import { Link } from "@tanstack/react-router";
import { useAssistantBindings } from "../../../lib/queries/assistant-admin";
import { formatRelative } from "../../../lib/relative-time";

// One row per project (LEFT JOIN assistant_settings; unconfigured rows render
// the "Not configured" treatment). Read-only overview — editing stays in the
// project settings surface.
export function AssistantBindingsTable() {
  const { data, isLoading, isError, refetch } = useAssistantBindings();
  const rows = data ?? [];
  const configured = rows.filter((r) => r.providerId !== null).length;

  return (
    <section className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="font-display text-base weight-500 color-primary">Project bindings</h2>
          {!isLoading && !isError ? (
            <div className="text-xs color-secondary mt-1">
              {rows.length} project{rows.length === 1 ? "" : "s"} · {configured} configured · {rows.length - configured} not configured
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => refetch()}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-sm color-muted text-center">Loading bindings…</div>
      ) : isError ? (
        <div className="px-4 py-6 text-center">
          <div className="font-mono text-xs" style={{ color: "var(--lx-text-danger)" }}>Failed to load bindings.</div>
          <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => refetch()}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <div className="empty-box">
            <div className="text-sm weight-500 color-primary">No projects yet</div>
            <p className="text-xs color-secondary" style={{ maxWidth: 360 }}>Create a project to configure its Assistant bindings.</p>
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th style={{ width: "auto" }}>Project</th>
                <th style={{ width: 150 }}>Provider</th>
                <th style={{ width: 210 }}>Model</th>
                <th style={{ width: 90, textAlign: "right" }}>Fallbacks</th>
                <th style={{ width: 90, textAlign: "right" }}>Write tools</th>
                <th style={{ width: 80, textAlign: "right" }}>Memory</th>
                <th style={{ width: 110 }}>Search</th>
                <th style={{ width: 110 }}>Updated</th>
                <th style={{ width: 110, textAlign: "right" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const unconfigured = r.providerId === null;
                return (
                  <tr key={r.projectId}>
                    <td>
                      <span className="text-sm weight-500 color-primary">{r.projectName}</span>{" "}
                      <span className="font-mono text-2xs color-muted">{r.projectSlug}</span>
                    </td>
                    {unconfigured ? (
                      <td colSpan={3} className="text-xs color-muted" style={{ fontStyle: "italic" }}>Not configured — no provider, model, or fallback chain set</td>
                    ) : (
                      <>
                        <td className="text-xs color-secondary">{r.providerLabel ?? "—"}</td>
                        <td className="font-mono text-xs color-primary">{r.modelLabel ?? "—"}</td>
                        <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{r.fallbackCount}</td>
                      </>
                    )}
                    <td className={`font-mono text-xs ${unconfigured ? "color-muted" : "color-secondary"}`} style={{ textAlign: "right" }}>{unconfigured ? "—" : r.writeToolsCount}</td>
                    <td className={`font-mono text-xs ${unconfigured ? "color-muted" : "color-secondary"}`} style={{ textAlign: "right" }}>{unconfigured ? "—" : r.memoryCount}</td>
                    <td>
                      {r.hasSearchKey ? (
                        <span className="health-status health-status--ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="m9 12 2 2 4-4" /></svg>Configured</span>
                      ) : (
                        <span className="health-status health-status--muted"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><path d="M12 7v5l3 2" /></svg>Not set</span>
                      )}
                    </td>
                    <td className={`text-xs ${unconfigured ? "color-muted" : "color-secondary"}`}>{unconfigured || !r.updatedAt ? "—" : formatRelative(r.updatedAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to="/settings/project/$projectId"
                        params={{ projectId: r.projectId }}
                        className={`btn ${unconfigured ? "btn-primary" : "btn-ghost"} btn-sm`}
                        style={{ textDecoration: "none" }}
                      >
                        {unconfigured ? "Configure" : "Manage"}
                      </Link>
                    </td>
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
