import { useState } from "react";
import { Plus, RotateCcw, Settings, Trash2 } from "lucide-react";
import { useRemoveRuntime } from "../../lib/queries";
import { RemoveRuntimeModal } from "./SettingsSections";
import { formatRelative } from "../../lib/relative-time";
import { RuntimeSetupModal } from "../forge/RuntimeSetupModal";
import { RuntimeEditModal } from "../forge/RuntimeEditModal";
import { RuntimeRestartModal } from "../forge/RuntimeRestartModal";
import type { Runtime } from "../../../shared/types";

// Team-scoped runtimes table (settings/team). Shows the team's own runtimes
// only — GET /api/forge/runtimes?teamId=; Global runtimes are a
// superadmin-only section on the workspace page.
export function TeamSettingsRuntimesTable({ teamId, runtimes, isLoading, isError }: { teamId: string; runtimes: Runtime[]; isLoading: boolean; isError: boolean }) {
  const removeRuntime = useRemoveRuntime();
  const [setupOpen, setSetupOpen] = useState(false);
  const [editing, setEditing] = useState<Runtime | null>(null);
  const [restarting, setRestarting] = useState<Runtime | null>(null);
  const [removing, setRemoving] = useState<Runtime | null>(null);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-lg font-medium text-lx-text-primary">Runtimes</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-lx-text-muted">Team scope</span>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setSetupOpen(true)}>
            <Plus size={14} strokeWidth={1.5} />
            Setup runtime
          </button>
        </div>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Daemons this team can claim Forge tasks on. Setup picks this team as the runtime's owner. Runtimes created by other teams are invisible here.
      </p>

      {isLoading ? (
        <div className="text-sm text-lx-text-muted py-8 text-center">Loading runtimes…</div>
      ) : isError ? (
        <div className="text-sm text-lx-text-danger py-8 text-center">Failed to load runtimes.</div>
      ) : runtimes.length === 0 ? (
        <div className="card-panel flex flex-col items-center gap-1.5 text-center mb-4" style={{ borderStyle: "dashed", borderColor: "var(--lx-border-strong)", padding: 24 }}>
          <div className="text-sm font-medium text-lx-text-primary">No runtimes in this team</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>Connect a machine with opencode, hermes, or command-code installed, then set up a runtime for this team.</p>
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12, marginTop: 8 }} onClick={() => setSetupOpen(true)}><Plus size={14} strokeWidth={1.5} />Setup runtime</button>
        </div>
      ) : (
        <div className="card-panel" style={{ overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr><th>Name</th><th>CLI</th><th>Model</th><th>Hostname</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {runtimes.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm font-medium">{r.name}</td>
                  <td className="text-xs text-lx-text-secondary">{r.provider}</td>
                  <td className="font-mono text-xs text-lx-text-secondary">{r.model || "—"}</td>
                  <td className="font-mono text-xs text-lx-text-secondary">{r.hostname || "—"}</td>
                  <td><span className="flex items-center gap-2"><span className={r.status === "online" ? "sync-dot sync-synced" : "sync-dot sync-unlinked"} /><span className={`font-micro text-2xs uppercase tracking-[0.04em] ${r.status === "online" ? "text-lx-text-success" : "text-lx-text-muted"}`}>{r.status === "online" ? "Online" : "Offline"}</span></span>{r.lastError && <span className="block text-xs mt-1" style={{ color: "var(--lx-text-warning)" }}>{r.lastError.toLowerCase().includes("api key") ? "API key revoked — re-run Setup runtime" : r.lastError}</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {r.status === "offline" && <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setRestarting(r)} aria-label={`Restart ${r.name}`} title="Restart guide"><RotateCcw size={14} strokeWidth={1.5} /></button>}
                    <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} title="Edit runtime"><Settings size={14} strokeWidth={1.5} /></button>
                    <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} onClick={() => setRemoving(r)} aria-label={`Remove ${r.name}`} title="Remove runtime"><Trash2 size={14} strokeWidth={1.5} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {setupOpen && <RuntimeSetupModal onClose={() => setSetupOpen(false)} />}
      {editing && <RuntimeEditModal runtime={editing} onClose={() => setEditing(null)} />}
      {restarting && <RuntimeRestartModal runtime={restarting} onClose={() => setRestarting(null)} />}
      {removing && (
        <RemoveRuntimeModal
          name={removing.name}
          hostname={removing.hostname}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeRuntime.mutate(removing.id, { onSuccess: () => setRemoving(null) });
          }}
        />
      )}
    </section>
  );
}
