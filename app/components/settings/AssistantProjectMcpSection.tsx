import { Link } from "@tanstack/react-router";
import { useMcpServers, useProjectMcpServers, useSetProjectMcpServers } from "../../lib/queries/assistant-admin";
import type { Project } from "../../../shared/types";
import { endpointOf } from "./assistant-mcp-logic";

// Per-project MCP server availability (wireframe settings-project-herald.html
// §MCP servers). DEFAULT OFF: absence of a row = unavailable. Global `enabled`
// is the master switch — a globally-disabled server renders a disabled toggle
// with "Global off" and can never be turned on here.
export function AssistantProjectMcpSection({ project }: { project: Project }) {
  const { data: servers = [], isLoading } = useMcpServers();
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
          <h2 className="font-display text-lg font-medium text-lx-text-primary">MCP servers</h2>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">read-only tools</span>
          <span className="text-xs text-lx-text-muted">default off</span>
        </div>
        <span className="text-xs text-lx-text-muted">Per project</span>
      </div>

      <div className="card-panel card-panel--elevated">
        {isLoading ? (
          <div className="text-sm text-lx-text-muted py-6 text-center">Loading…</div>
        ) : servers.length === 0 ? (
          <p className="text-sm text-lx-text-muted">
            No MCP servers registered — add one in <Link to="/settings/workspace" className="text-lx-text-link">Workspace → Assistant Providers</Link>.
          </p>
        ) : (
          <div className="card-panel" style={{ padding: 0, overflow: "hidden" }}>
            <table className="settings-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Enabled</th>
                  <th style={{ width: "30%" }}>Server</th>
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
                          aria-label={globalOn ? `${server.label} ${projectOn ? "enabled" : "not enabled"} for this project` : `${server.label} not enabled for this project`}
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

        <div className="field-hint mt-3">Which registered MCP servers this project&apos;s Assistant may call. A server must be enabled globally first (Workspace → Assistant Providers → MCP Servers); then it must be explicitly enabled here.</div>
      </div>
    </section>
  );
}
