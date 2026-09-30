import { useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { useMcpServers, useMcpManagedSecrets, useCreateMcpServer, useUpdateMcpServer, useDeleteMcpServer, useTestMcpServer } from "../../lib/queries/assistant-admin";
import type { McpServer } from "../../lib/api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  MCP_TRANSPORTS,
  canSubmitMcpForm,
  endpointOf,
  mcpFormPayload,
  mcpFormStateFrom,
  requestClearSecret,
  slugifyMcpId,
  toolCountsLabel,
  withSecretField,
  type McpFormState,
  type McpTestState,
} from "./assistant-mcp-logic";

// Workspace → Assistant Providers → MCP Clients registry (superadmin-gated).
// Mirrors the wireframe admin-assistant-providers.html §MCP Clients; the same
// component renders on the admin control panel and the workspace Integrations
// tab. Global `enabled` is the master switch; per-project availability lives in
// AssistantProjectMcpSection.
//
// `managedSecretsEnabled` is read from the registry list response — the server
// owns the capability (a master key must exist for a token to be encrypted), so
// nothing here assumes it. The two hooks share one query key, so the flag and
// the rows always describe the same read.
export function AssistantMcpSection() {
  const { data: servers = [], isLoading } = useMcpServers();
  // Tri-state, kept to the render: true (key present), false (the server said
  // it is absent), undefined (unanswered — in flight, or a failed list request,
  // which never retries). Only `false` is a fact the warning notice may state;
  // the token field is disabled until the answer is `true`, because offering it
  // early would only produce a save the API refuses. A stored token stays
  // visible and clearable regardless. The two hooks share one query key, so the
  // flag and the rows always describe the same read.
  const { data: managedSecretsEnabled } = useMcpManagedSecrets();
  const update = useUpdateMcpServer();
  const remove = useDeleteMcpServer();
  const test = useTestMcpServer();

  const [testStates, setTestStates] = useState<Record<string, McpTestState>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const editing: McpServer | null = editingId ? servers.find((s) => s.id === editingId) ?? null : null;

  const handleTest = (id: string) => {
    setTestStates((m) => ({ ...m, [id]: { state: "pending" } }));
    test.mutate(id, {
      onSuccess: (res) => {
        if (res.ok) {
          setTestStates((m) => ({ ...m, [id]: { state: "ok", latencyMs: res.latencyMs, toolCount: res.toolCount, readOnlyToolCount: res.readOnlyToolCount } }));
        } else {
          setTestStates((m) => ({ ...m, [id]: { state: "fail", code: res.error?.code ?? "MCP_CONNECT_FAILED", message: res.error?.message } }));
        }
      },
      onError: (err) => {
        const e = err as { code?: string; message?: string };
        setTestStates((m) => ({ ...m, [id]: { state: "fail", code: e.code ?? "MCP_CONNECT_FAILED", message: e.message } }));
      },
    });
  };

  const handleToggleEnabled = (server: McpServer) => {
    update.mutate({ id: server.id, enabled: !server.enabled });
  };

  const handleDelete = () => {
    if (!deleteConfirm) return;
    remove.mutate(deleteConfirm, { onSuccess: () => setDeleteConfirm(null) });
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">MCP Clients</h2>
          <span className="text-xs text-lx-text-muted">superadmin-gated</span>
        </div>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <div className="card-panel" style={{ overflow: "hidden" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Enabled</th>
              <th style={{ width: "24%" }}>Client</th>
              <th style={{ width: 90 }}>Transport</th>
              <th style={{ width: "30%" }}>Endpoint</th>
              <th style={{ width: "14%" }}>Tools</th>
              <th style={{ width: "20%", textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td><div className="skeleton" style={{ width: 34, height: 18, borderRadius: 9999 }} /></td>
                <td><div className="skeleton" style={{ width: 120, height: 14 }} /></td>
                <td><div className="skeleton" style={{ width: 52, height: 16, borderRadius: 9999 }} /></td>
                <td><div className="skeleton" style={{ width: 200, height: 14 }} /></td>
                <td><div className="skeleton" style={{ width: 70, height: 14 }} /></td>
                <td><div className="skeleton" style={{ width: 120, height: 14, marginLeft: "auto" }} /></td>
              </tr>
            ) : (
              servers.map((server) => (
                <McpClientRow
                  key={server.id}
                  server={server}
                  testState={testStates[server.id]}
                  onToggleEnabled={() => handleToggleEnabled(server)}
                  onTest={() => handleTest(server.id)}
                  onEdit={() => setEditingId(server.id)}
                  onDelete={() => setDeleteConfirm(server.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {!isLoading && servers.length === 0 && (
        <div className="card-panel mt-3" style={{ background: "var(--lx-surface-elevated)" }}>
          <span className="text-sm font-medium text-lx-text-primary">No MCP clients yet</span>
          <p className="text-xs text-lx-text-secondary mt-1">Add a remote MCP client below. No clients are pre-seeded.</p>
        </div>
      )}

      <McpClientForm key={editingId ?? "new"} editing={editing} managedSecretsEnabled={managedSecretsEnabled} onCancel={() => setEditingId(null)} />

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete MCP client?"
          body={
            <>
              Remove <span className="font-mono text-xs" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px", color: "var(--lx-text-primary)" }}>{deleteConfirm}</span> from the registry. Assistant loses its tools on the next run, and every project&apos;s availability entry for it is removed. This cannot be undone.
            </>
          }
          confirmLabel="Delete client"
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={handleDelete}
        />
      )}
    </section>
  );
}

function McpClientRow({
  server,
  testState,
  onToggleEnabled,
  onTest,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  testState: McpTestState | undefined;
  onToggleEnabled: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr style={{ opacity: server.enabled ? 1 : 0.6 }}>
      <td>
        <button
          type="button"
          className={`toggle-switch${server.enabled ? " is-on" : ""}`}
          aria-label={`${server.label} ${server.enabled ? "enabled" : "disabled"}`}
          aria-pressed={server.enabled}
          onClick={onToggleEnabled}
        />
      </td>
      <td>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          <span className={`text-sm font-medium ${server.enabled ? "text-lx-text-primary" : "text-lx-text-secondary"}`}>{server.label}</span>
          <span className="font-mono text-2xs text-lx-text-muted">{server.id}</span>
        </div>
      </td>
      <td><span className="mcp-transport-badge font-mono text-2xs">{server.transportType}</span></td>
      <td className={`font-mono text-xs ${server.enabled ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>{endpointOf(server)}</td>
      <td className={`text-xs ${server.enabled ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>{toolCountsLabel(testState)}</td>
      <td style={{ textAlign: "right" }}>
        <div className="table-actions">
          {testState?.state === "pending" && (
            <span className="flex items-center justify-end gap-2" style={{ display: "inline-flex" }}>
              <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              <span className="text-xs text-lx-text-secondary">Testing…</span>
            </span>
          )}
          {testState?.state === "fail" && (
            <span className="font-mono text-xs text-lx-text-danger">{testState.code}</span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" title="Test connection" onClick={onTest}>Test</button>
          <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Edit MCP client" onClick={onEdit}>
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button type="button" className="btn btn-danger btn-icon-sm" aria-label="Delete MCP client" onClick={onDelete}>
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function McpClientForm({ editing, managedSecretsEnabled, onCancel }: { editing: McpServer | null; managedSecretsEnabled: boolean | undefined; onCancel: () => void }) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const [state, setState] = useState<McpFormState>(() => mcpFormStateFrom(editing));
  const [clearConfirm, setClearConfirm] = useState(false);

  const editingFlag = editing !== null;
  const derivedId = editing ? editing.id : slugifyMcpId(state.label);
  const set = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => setState((prev) => ({ ...prev, [key]: value }));

  const tokenEnabled = managedSecretsEnabled === true;
  // The stored secret and its ciphertext row are both write-only: the
  // list/detail response carries hasSecret + secretSource and nothing else, so
  // the chip is a fixed-width mask — never a value, a name, a path, or a suffix.
  const hasSecret = (editing?.hasSecret ?? false) && !state.clearPending;

  const handleSave = () => {
    const payload = mcpFormPayload(state);
    if (!payload) return;
    if (editing) {
      update.mutate({ id: editing.id, ...payload }, { onSuccess: onCancel });
    } else {
      create.mutate(payload, { onSuccess: onCancel });
    }
  };

  return (
    <div className="card-panel card-panel--elevated mt-4">
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Add / Edit MCP client</h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="mcp-label">Label</label>
          <input id="mcp-label" className="prop-input w-full" placeholder="Linear" value={state.label} onChange={(e) => set("label", e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="mcp-id">ID <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>slug</span></label>
          <input id="mcp-id" className="prop-input w-full font-mono" placeholder="linear" value={derivedId} readOnly aria-label="ID" />
        </div>
      </div>

      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <label className="field-label" htmlFor="mcp-transport">Transport</label>
        <select
          id="mcp-transport"
          className="prop-input"
          style={{ width: 240, height: 32, fontSize: 12 }}
          value={state.transportType}
          onChange={(e) => set("transportType", e.target.value as McpFormState["transportType"])}
        >
          {MCP_TRANSPORTS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="card-panel" style={{ padding: 12, background: "var(--lx-surface-input)", marginTop: 12 }}>
        <div className="flex items-center gap-2 mb-2">
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">remote transport = http | sse</span>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="mcp-url">URL</label>
          <input id="mcp-url" className="prop-input w-full font-mono" placeholder="https://mcp.linear.example/mcp" value={state.url} onChange={(e) => set("url", e.target.value)} />
          <div className="field-hint">Enter a web address (http:// or https://).</div>
        </div>
      </div>

      {managedSecretsEnabled === false && (
        <div className="notice notice-warning mt-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>Token storage is turned off on this server, so tokens can't be saved yet. A pending removal can still be cancelled.</span>
        </div>
      )}

      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <label className="field-label" style={{ marginBottom: 0 }} htmlFor="mcp-token">Bearer token</label>
          {hasSecret ? (
            <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
              Saved · <span className="font-mono">••••••••</span>
            </span>
          ) : (
            tokenEnabled && !state.clearPending && (
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">write-only</span>
            )
          )}
        </div>

        <input
          id="mcp-token"
          className="prop-input w-full font-mono"
          type="password"
          // "Empty keeps the stored token" is load-bearing: it is why a masked
          // field is never a removal route. It rides in the placeholder because
          // the prose version was a paragraph per state. A pending clear on a
          // disabled field cannot be typed away (no master key), so it must not
          // promise a keystroke: it states the Save outcome instead, and the
          // Keep token button below is its cancel route.
          placeholder={
            state.clearPending
              ? tokenEnabled
                ? "Type to cancel the pending clear"
                : "Save removes the stored token"
              : "Leave empty to keep stored token"
          }
          autoComplete="off"
          disabled={!tokenEnabled}
          value={state.secret}
          onChange={(e) => setState((prev) => withSecretField(prev, e.target.value))}
        />

        {hasSecret && (
          <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setClearConfirm(true)}>
              <Trash2 size={14} strokeWidth={1.5} />
              Clear secret
            </button>
          </div>
        )}

        {state.clearPending && (
          <div className="notice notice-danger" style={{ marginTop: 10 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span>Secret will be removed on Save.</span>
          </div>
        )}

        {state.clearPending && !tokenEnabled && (
          <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setState((prev) => ({ ...prev, clearPending: false }))}>
              Keep token
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSubmitMcpForm(state) || create.isPending || update.isPending}>
          Save client
        </button>
        {editingFlag && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>

      {clearConfirm && editing && (
        <ConfirmDialog
          title="Clear secret?"
          body={
            <>
              Remove the Bearer secret from <span className="font-mono text-xs" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px", color: "var(--lx-text-primary)" }}>{editing.id}</span>. The next run connects with no <span className="font-mono">Authorization</span> header, so the client stops authenticating — public tools keep answering, private ones start failing. The stored value is deleted, not archived, and it is never shown to you again. This cannot be undone.
            </>
          }
          confirmLabel="Clear secret"
          onCancel={() => setClearConfirm(false)}
          onConfirm={() => { setClearConfirm(false); setState((prev) => requestClearSecret(prev)); }}
        />
      )}
    </div>
  );
}
