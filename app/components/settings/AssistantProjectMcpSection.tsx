import { Link } from "@tanstack/react-router";
import { useMcpServers, useProjectMcpServers, useSetProjectMcpServers } from "../../lib/queries/assistant-admin";
import type { Project } from "../../../shared/types";
import { endpointOf } from "./assistant-mcp-logic";

// Per-project MCP client availability (wireframe settings-project-herald.html
// §MCP clients). DEFAULT OFF: absence of a row = unavailable. Global `enabled`
// is the master switch — a globally-disabled client renders a disabled toggle
// with "Global off" and can never be turned on here.
export function AssistantProjectMcpSection({ project }: { project: Project }) {
  const { data: servers = [], isLoading, isError } = useMcpServers();
  const { data: rows = [] } = useProjectMcpServers(project.id);
  const save = useSetProjectMcpServers(project.id);

  const enabledFor = (serverId: string): boolean => rows.find((r) => r.serverId === serverId)?.enabled ?? false;

  const toggle = (serverId: string) => {
    const next = servers.map((s) => ({ serverId: s.id, enabled: s.id === serverId ? !enabledFor(s.id) : enabledFor(s.id) }));
    save.mutate(next);
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">MCP clients</h2>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">read-only tools</span>
          <span className="text-xs text-lx-text-muted">default off</span>
        </div>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>

      {isLoading ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-muted py-6 text-center">Loading…</div>
        </div>
      ) : isError ? (
        <div className="card-panel card-panel--elevated">
          <div className="text-sm text-lx-text-danger py-6 text-center" role="alert">Failed to load MCP clients.</div>
        </div>
      ) : servers.length === 0 ? (
        <div className="empty-box" style={{ padding: "20px 16px" }}>
          <div className="text-sm font-medium text-lx-text-primary">No MCP clients registered</div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 360 }}>Register a remote MCP client in Workspace settings before enabling it for this project.</p>
          <Link to="/settings/workspace" className="btn btn-ghost btn-sm">Workspace → Assistant Providers</Link>
        </div>
      ) : (
        <div className="card-panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Enabled</th>
                <th style={{ width: "30%" }}>Client</th>
                <th style={{ width: 90 }}>Transport</th>
                <th style={{ width: "30%" }}>Endpoint</th>
                <th style={{ width: "20%", textAlign: "right" }}>Tools</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const globalOn = server.enabled;
                const projectOn = globalOn && enabledFor(server.id);
                return (
                  <tr key={server.id} style={{ opacity: globalOn ? 1 : 0.6 }}>
                    <td>
                      <button
                        type="button"
                        className={`toggle-switch${projectOn ? " is-on" : ""}`}
                        aria-label={server.label}
                        aria-pressed={projectOn}
                        disabled={!globalOn || save.isPending}
                        onClick={() => toggle(server.id)}
                      />
                    </td>
                    <td>
                      <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                        <span className={`text-sm font-medium ${globalOn ? "text-lx-text-primary" : "text-lx-text-secondary"}`}>{server.label}</span>
                        <span className="font-mono text-2xs text-lx-text-muted">{server.id}</span>
                      </div>
                    </td>
                    <td><span className="mcp-transport-badge font-mono text-2xs">{server.transportType}</span></td>
                    <td className={`font-mono text-xs ${globalOn ? "text-lx-text-secondary" : "text-lx-text-muted"}`}>{endpointOf(server)}</td>
                    <td className={`text-xs ${globalOn ? "text-lx-text-secondary" : "text-lx-text-muted"}`} style={{ textAlign: "right" }}>{globalOn ? "—" : "Global off"}</td>
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
