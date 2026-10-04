import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAssistantRuns } from "../../../lib/queries/assistant-admin";
import { useProjects } from "../../../lib/queries";
import { formatDuration, formatTimestamp, RunStatusChip, runDocumentTarget, runKindLabel } from "./run-display";
import type { AssistantRunRow, AssistantRunStatus } from "../../../lib/api";

const STATUS_FILTERS: { value: AssistantRunStatus | null; label: string; color: string }[] = [
  { value: null, label: "All", color: "" },
  { value: "completed", label: "Done", color: "var(--lx-text-success)" },
  { value: "running", label: "Running", color: "var(--lx-text-warning)" },
  { value: "failed", label: "Failed", color: "var(--lx-text-danger)" },
  { value: "queued", label: "Queued", color: "var(--lx-text-muted)" },
  { value: "cancelled", label: "Cancelled", color: "var(--lx-text-muted)" },
];

const PAGE_SIZE = 50;

export function AssistantRunsTable() {
  const { data: projects } = useProjects();
  const [status, setStatus] = useState<AssistantRunStatus | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const cursor = cursorStack[cursorStack.length - 1] ?? null;
  const { data, isLoading, isError, refetch } = useAssistantRuns({ status, projectId: projectId || null, limit: PAGE_SIZE, cursor });

  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const rows = data?.data ?? [];
  const counts = data?.counts;
  const total = counts ? counts.queued + counts.running + counts.completed + counts.failed + counts.cancelled : 0;

  const resetPage = () => { setCursorStack([null]); setExpanded(null); };
  const applyStatus = (value: AssistantRunStatus | null) => { setStatus(value); resetPage(); };
  const applyProject = (value: string) => { setProjectId(value); resetPage(); };

  const documentCell = (r: AssistantRunRow) => {
    const project = projectById.get(r.projectId);
    const prefix = (
      <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {runKindLabel(r)}
      </span>
    );
    const label = <>{prefix} · {r.documentTitle || "—"}</>;
    const target = runDocumentTarget(r);
    if (!project || !target) return <span className="text-xs color-primary">{label}</span>;
    if (target.kind === "task") {
      return (
        <Link to="/$slug/tasks/$taskId" params={{ slug: project.slug, taskId: target.value }} className="text-xs color-primary" style={{ textDecoration: "none" }}>
          {label}
        </Link>
      );
    }
    return (
      <Link to="/$slug/wiki/$pageSlug" params={{ slug: project.slug, pageSlug: target.value }} className="text-xs color-primary" style={{ textDecoration: "none" }}>
        {label}
      </Link>
    );
  };

  return (
    <section className="card-panel" style={{ overflow: "hidden", padding: 0 }}>
      <div style={{ padding: "16px 16px 12px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="font-display text-base weight-500 color-primary">Recent runs</h2>
          {counts ? (
            <div className="text-xs color-secondary mt-1">
              {total.toLocaleString()} runs · {counts.completed.toLocaleString()} done · {counts.failed.toLocaleString()} failed · {counts.running.toLocaleString()} running · {counts.queued.toLocaleString()} queued
              {counts.cancelled > 0 ? ` · ${counts.cancelled.toLocaleString()} cancelled` : ""}
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => refetch()}>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          Refresh
        </button>
      </div>

      <div style={{ padding: "0 16px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Status</span>
        {STATUS_FILTERS.map((f) => {
          const active = status === f.value;
          return (
            <button
              key={f.label}
              type="button"
              className="status-chip"
              aria-pressed={active}
              onClick={() => applyStatus(f.value)}
              style={active ? { borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" } : undefined}
            >
              {f.value ? <span className="status-dot" style={{ background: f.color }} /> : null}
              {f.label}
            </button>
          );
        })}
        <span style={{ width: 1, height: 20, background: "var(--lx-border-default)", margin: "0 4px" }} />
        <select
          className="prop-input"
          aria-label="Project filter"
          value={projectId}
          onChange={(e) => applyProject(e.target.value)}
          style={{ height: 28, padding: "0 8px", fontSize: 12, minWidth: 160 }}
        >
          <option value="">All projects</option>
          {(projects ?? []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
        </select>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="settings-table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Time</th>
              <th style={{ width: 120 }}>Project</th>
              <th>Document</th>
              <th style={{ width: 120 }}>Agent</th>
              <th style={{ width: 130 }}>Skill</th>
              <th style={{ width: 110 }}>Status</th>
              <th style={{ width: 90, textAlign: "right" }}>Duration</th>
              <th style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && rows.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={8} style={{ padding: "10px 12px" }}><div className="skeleton" style={{ height: 12, width: "100%" }} /></td>
                </tr>
              ))
            ) : isError ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs" style={{ color: "var(--lx-text-danger)" }}>Failed to load runs.</div>
                  <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => refetch()}>Retry</button>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: "14px 12px" }}>
                  <div className="font-mono text-xs color-muted" style={{ fontStyle: "italic" }}>No runs for these filters</div>
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const expandable = !!r.error && (r.status === "failed" || r.status === "cancelled");
                const isOpen = expanded === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="font-mono text-xs color-secondary">{formatTimestamp(r.createdAt)}</td>
                      <td className="text-xs weight-500 color-primary">{projectById.get(r.projectId)?.name ?? "—"}</td>
                      <td>{documentCell(r)}</td>
                      <td className="text-xs color-secondary">{r.agentName || "—"}</td>
                      <td className="text-xs color-secondary">{r.skillName || "—"}</td>
                      <td><RunStatusChip status={r.status} /></td>
                      <td className="font-mono text-xs color-secondary" style={{ textAlign: "right" }}>{formatDuration(r.startedAt, r.finishedAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        {expandable ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon-sm"
                            aria-label="Show error"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded((prev) => (prev === r.id ? null : r.id))}
                          >
                            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--lx-text-danger)" strokeWidth={1.5}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {expandable && isOpen ? (
                      <tr key={`${r.id}-error`}>
                        <td colSpan={8} style={{ padding: 0, border: "none" }}>
                          <div className="notice notice-danger" style={{ margin: "0 16px 4px" }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><circle cx={12} cy={12} r={10} /><line x1={12} y1={8} x2={12} y2={12} /><line x1={12} y1={16} x2={12.01} y2={16} /></svg>
                            <span className="font-mono text-xs">{r.error}</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "12px 16px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderTop: "1px solid var(--lx-border-subtle)" }}>
        <span className="text-xs color-secondary">Showing {rows.length} of {total.toLocaleString()} runs · newest first</span>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-ghost btn-sm" disabled={cursorStack.length <= 1} onClick={() => setCursorStack((s) => s.slice(0, -1))}>Previous</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!data?.nextCursor} onClick={() => data?.nextCursor && setCursorStack((s) => [...s, data.nextCursor])}>Load more</button>
        </div>
      </div>
    </section>
  );
}
