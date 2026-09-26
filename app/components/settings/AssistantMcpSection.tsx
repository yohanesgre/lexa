import { useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { useMcpServers, useCreateMcpServer, useUpdateMcpServer, useDeleteMcpServer, useTestMcpServer } from "../../lib/queries/assistant-admin";
import type { McpServer } from "../../lib/api";
import { WarningNotice } from "../ui/NoticeWarning";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  MCP_TRANSPORTS,
  canSubmitMcpForm,
  endpointOf,
  isSeededMcpServer,
  mcpFormPayload,
  mcpFormStateFrom,
  slugifyMcpId,
  toolCountsLabel,
  type McpFormState,
  type McpTestState,
} from "./assistant-mcp-logic";

// Workspace → Assistant Providers → MCP Servers registry (superadmin-gated).
// Mirrors the wireframe admin-assistant-providers.html §MCP Servers; the same
// component renders on the admin control panel and the workspace Integrations
// tab. Global `enabled` is the master switch; per-project availability lives in
// AssistantProjectMcpSection.
export function AssistantMcpSection() {
  const { data: servers = [], isLoading } = useMcpServers();
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
          <h2 className="font-display text-lg font-medium text-lx-text-primary">MCP Servers</h2>
          <span className="text-xs text-lx-text-muted">superadmin-gated</span>
        </div>
        <span className="text-xs text-lx-text-muted">Workspace scope</span>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 640 }}>
        Model Context Protocol servers Assistant may call as tools. The transport decides where a server can run — <span className="font-mono">stdio</span> spawns a child process (same-host Bun server only); <span className="font-mono">http</span> / <span className="font-mono">sse</span> reach a URL from anywhere. v1 exposes only read-only-annotated tools to the model; the rest are listed but not callable. Credentials are referenced, never stored (<span className="font-mono">env:NAME</span> or <span className="font-mono">file:/abs/path</span>).
      </p>

      <div className="card-panel" style={{ overflow: "hidden" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Enabled</th>
              <th style={{ width: "24%" }}>Server</th>
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
            ) : servers.length === 0 ? (
              <tr><td colSpan={6} className="text-sm text-lx-text-muted" style={{ textAlign: "center", padding: 24 }}>No MCP servers registered — add one below.</td></tr>
            ) : (
              servers.map((server) => (
                <McpServerRow
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

      <McpServerForm key={editingId ?? "new"} editing={editing} onCancel={() => setEditingId(null)} />

      <WarningNotice className="mt-4" title="Only read-only tools are exposed">
        v1 hands the model only tools the server annotates as read-only (<span className="font-mono">readOnlyHint === true</span>); a tool with no annotation is denied by default. Non-read-only tools are listed in the counts but never callable — a server that exposes none still shows its total, so a fully-gated server is explainable rather than mysterious.
      </WarningNotice>

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete MCP server?"
          body={
            <>
              Remove <span className="font-mono text-xs" style={{ background: "var(--lx-surface-card)", borderRadius: 4, padding: "2px 5px", color: "var(--lx-text-primary)" }}>{deleteConfirm}</span> from the registry. Assistant loses its tools on the next run, and every project&apos;s availability entry for it is removed. This cannot be undone.
            </>
          }
          confirmLabel="Delete server"
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={handleDelete}
        />
      )}
    </section>
  );
}

function McpServerRow({
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
  const seeded = isSeededMcpServer(server);
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
          {seeded && <span className="mcp-seeded-tag font-mono text-2xs">seeded</span>}
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
          <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Edit MCP server" onClick={onEdit}>
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button type="button" className="btn btn-danger btn-icon-sm" aria-label="Delete MCP server" onClick={onDelete}>
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function McpServerForm({ editing, onCancel }: { editing: McpServer | null; onCancel: () => void }) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const [state, setState] = useState<McpFormState>(() => mcpFormStateFrom(editing));

  const editingFlag = editing !== null;
  const derivedId = editing ? editing.id : slugifyMcpId(state.label);
  const set = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => setState((prev) => ({ ...prev, [key]: value }));

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
      <h3 className="font-display text-base font-medium text-lx-text-primary mb-3">Add / Edit MCP server</h3>
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
        <div className="field-hint">Switching transport swaps the endpoint fields below — URL for http/sse, command + args for stdio. The row stores exactly one of them (DB CHECK: url xor command).</div>
      </div>

      {state.transportType === "stdio" ? (
        <div className="card-panel" style={{ padding: 12, background: "var(--lx-surface-input)", marginTop: 12 }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">transport = stdio</span>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="mcp-command">Command</label>
            <input id="mcp-command" className="prop-input w-full font-mono" placeholder="jev-mcp" value={state.command} onChange={(e) => set("command", e.target.value)} />
          </div>
          <div className="field mt-3" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="mcp-args">Args <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 6 }}>JSON array · one token each</span></label>
            <input id="mcp-args" className="prop-input w-full font-mono" placeholder='["--stdio", "--profile", "work"]' value={state.args} onChange={(e) => set("args", e.target.value)} />
            <div className="field-hint">Never a shell string — args pass as an argv array. <span style={{ color: "var(--lx-text-warning)" }}>stdio runs only when the Lexa server runs on this host (self-hosted Bun); not available on Cloudflare Workers.</span></div>
          </div>
        </div>
      ) : (
        <div className="card-panel" style={{ padding: 12, background: "var(--lx-surface-input)", marginTop: 12 }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">transport = http | sse</span>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field-label" htmlFor="mcp-url">URL</label>
            <input id="mcp-url" className="prop-input w-full font-mono" placeholder="https://mcp.linear.example/mcp" value={state.url} onChange={(e) => set("url", e.target.value)} />
            <div className="field-hint">http(s) only · no userinfo. SSRF-checked against the URL allowlist at save and again at connect.</div>
          </div>
        </div>
      )}

      <div className="field mt-3" style={{ marginBottom: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <label className="field-label" style={{ marginBottom: 0 }} htmlFor="mcp-secret">Secret reference</label>
          {editing?.hasSecret && (
            <span className="chip font-micro text-2xs" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px", background: "var(--lx-bg-accent-subtle)", color: "var(--lx-text-link)" }}>
              Saved · <span className="font-mono">env:…</span>
            </span>
          )}
        </div>
        <input id="mcp-secret" className="prop-input w-full font-mono" placeholder="env:NAME or file:/abs/path" value={state.secretRef} onChange={(e) => set("secretRef", e.target.value)} style={{ maxWidth: 480 }} />
        <div className="field-hint">Credential is referenced, never stored: <span className="font-mono">env:NAME</span> (host env) or <span className="font-mono">file:/abs/path</span> (mounted file). Resolved at connect time; read back as <span className="font-mono">hasSecret</span> only. Empty keeps the stored reference.</div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!canSubmitMcpForm(state) || create.isPending || update.isPending}>
          Save server
        </button>
        {editingFlag && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
