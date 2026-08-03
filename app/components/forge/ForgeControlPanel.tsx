import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, LayoutGrid, Maximize, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "../ui/cn";
import { parseApiDate } from "../../lib/date";
import { copyToClipboard } from "../../lib/clipboard";
import { useCancelForgeTask, useForgeTask, useForgeTaskHistory, useForgeTaskLogs, useForgeSkills, useProjects, useRuntimes } from "../../lib/queries";
import { ForgeTaskLogModal } from "./ForgeTaskLogModal";
import type { ForgeTask, ForgeTaskStatus } from "../../../shared/types";

const STATUS_ORDER: ForgeTaskStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

const STATUS_META: Record<ForgeTaskStatus, { label: string; color: string; dot: string; tint: string }> = {
  queued: { label: "Queued", color: "text-lx-text-warning", dot: "var(--lx-text-warning)", tint: "var(--lx-bg-warning-subtle)" },
  running: { label: "Running", color: "text-lx-text-warning", dot: "var(--lx-text-warning)", tint: "var(--lx-bg-warning-subtle)" },
  completed: { label: "Done", color: "text-lx-text-success", dot: "var(--lx-text-success)", tint: "var(--lx-bg-success-subtle)" },
  failed: { label: "Failed", color: "text-lx-text-danger", dot: "var(--lx-text-danger)", tint: "var(--lx-bg-danger-subtle)" },
  cancelled: { label: "Cancelled", color: "text-lx-text-muted", dot: "var(--lx-text-muted)", tint: "var(--lx-surface-selected)" },
};

const LOG_TIME_FMT = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function formatLogTime(iso: string): string {  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return LOG_TIME_FMT.format(d);
}

function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  return `${d}d ago`;
}

// Same-day runs show the wall-clock time ("14:02"); older ones fall back to
// the relative label, matching the wireframe's Started/Finished columns.
function formatDayTime(iso: string | null): string {
  if (!iso) return "—";
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? LOG_TIME_FMT.format(d).slice(0, 5) : formatRelative(iso);
}

function durationLabel(task: ForgeTask): string {
  const start = task.startedAt ? parseApiDate(task.startedAt).getTime() : null;
  const end = task.finishedAt ? parseApiDate(task.finishedAt).getTime() : null;
  const ms = end !== null && start !== null ? end - start : task.status === "running" && start !== null ? Date.now() - start : null;
  if (ms === null || Number.isNaN(ms) || ms < 0) return STATUS_META[task.status].label;
  const min = ms / 60000;
  return min < 1 ? `${Math.max(1, Math.round(min * 60))}s` : `${min.toFixed(1)} min`;
}

function timelineLabel(task: ForgeTask): string {
  if (!task.startedAt) return `Created ${formatLogTime(task.createdAt)}`;
  if (!task.finishedAt) return `Created ${formatLogTime(task.createdAt)} · Started ${formatLogTime(task.startedAt)}`;
  return `Created ${formatLogTime(task.createdAt)} · Started ${formatLogTime(task.startedAt)} · Finished ${formatLogTime(task.finishedAt)}`;
}

function openDocumentPath(task: ForgeTask, projectSlug: string | undefined): string {
  // The task document surface is the board (task detail slideover opens via
  // the ?task= search param); wiki pages are their own route.
  return task.documentType === "wiki" ? `/${projectSlug ?? ""}/wiki/${task.documentId}` : `/${projectSlug ?? ""}/?task=${task.documentId}`;
}

export function ForgeControlPanel() {
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  const [status, setStatus] = useState<ForgeTaskStatus | null>(null);
  const [slug, setSlug] = useState("");
  const [skillId, setSkillId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const skills = useForgeSkills();
  const history = useForgeTaskHistory({ slug: slug || undefined, status: status ?? undefined, skillId: skillId || undefined }, cursor);
  const runtimes = useRuntimes();
  const projects = useProjects();
  const selected = useForgeTask(selectedId, selectedId !== null);
  const logs = useForgeTaskLogs(selectedId, selectedId !== null);
  const cancelTask = useCancelForgeTask();

  const page = history.data?.data ?? [];
  const summary = history.data?.summary;
  const online = runtimes.data?.filter((r) => r.status === "online").length ?? 0;
  const total = runtimes.data?.length ?? 0;

  const reset = (next: { slug?: string; status?: ForgeTaskStatus | null; skillId?: string }) => {
    if (next.slug !== undefined) setSlug(next.slug);
    if (next.status !== undefined) setStatus(next.status ?? null);
    if (next.skillId !== undefined) setSkillId(next.skillId);
    setCursor(null);
  };

  const runtimeName = (id: string | null): string => {
    if (!id) return "—";
    return runtimes.data?.find((r) => r.id === id)?.name ?? "—";
  };

  // Copy the task id to the clipboard (for debugging — daemon logs, API,
  // MCP tools). Shows a transient check on the row, like the navbar panel.
  const copyTaskId = (id: string) => {
    void copyToClipboard(id).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    });
  };

  const row = page.find((t) => t.id === selectedId) ?? null;
  const detail = (selected.data ?? row ?? null) as (ForgeTask & { projectName?: string }) | null;
  const detailProjectSlug = detail ? projects.data?.find((p) => p.id === detail.projectId)?.slug : undefined;

  const activeCount = (summary?.queued ?? 0) + (summary?.running ?? 0);

  return (
    <>
      <main className="page-frame">
      <div className="flex items-center justify-between mb-3">
        <h1 className="font-display text-2xl weight-600 color-primary mb-0">Forge</h1>
        <div className="flex items-center gap-3">
          <Link to="/settings" className="btn btn-ghost" style={{ height: 28, padding: "0 12px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <LayoutGrid size={14} strokeWidth={1.5} />
            Forge runtimes
          </Link>
        </div>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Every AI writing-assist run across all projects, newest first. Rows open the task record: activity feed, result, and failure details.
      </p>

      {/* Summary strip — counts ride the history response (no separate aggregate endpoint) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "10px 14px" }}>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Active</div>
          <div className="font-display text-xl weight-600 text-lx-text-warning" style={{ lineHeight: 1.2 }}>
            {summary ? activeCount : "—"}
            <span className="font-micro text-2xs color-muted" style={{ marginLeft: 6 }}>
              {(summary?.running ?? 0) > 0 ? "running" : (summary?.queued ?? 0) > 0 ? "queued" : "idle"}
            </span>
          </div>
        </div>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "10px 14px" }}>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Queued</div>
          <div className="font-display text-xl weight-600 color-primary" style={{ lineHeight: 1.2 }}>{summary ? summary.queued : "—"}</div>
        </div>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "10px 14px" }}>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Done</div>
          <div className="font-display text-xl weight-600 text-lx-text-success" style={{ lineHeight: 1.2 }}>{summary ? summary.completed : "—"}</div>
        </div>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "10px 14px" }}>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Failed</div>
          <div className="font-display text-xl weight-600 text-lx-text-danger" style={{ lineHeight: 1.2 }}>{summary ? summary.failed : "—"}</div>
        </div>
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: "10px 14px" }}>
          <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Runtimes</div>
          <div className="font-display text-xl weight-600 color-primary" style={{ lineHeight: 1.2 }}>
            {total > 0 ? online : "—"}
            {total > 0 && <span className="font-micro text-2xs color-muted" style={{ marginLeft: 6 }}>/ {total} online</span>}
          </div>
        </div>
      </div>

      {/* Filter bar — one segmented control; the status dot carries the status color */}
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginBottom: 12 }}>
        <button
          type="button"
          className="status-chip"
          aria-pressed={status === null}
          style={status === null ? { background: "var(--lx-surface-selected)", borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" } : undefined}
          onClick={() => reset({ status: null })}
        >
          All
        </button>
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className="status-chip"
            aria-pressed={status === s}
            style={status === s ? { background: STATUS_META[s].tint, borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" } : undefined}
            onClick={() => reset({ status: s })}
          >
            <span className="status-dot" style={{ background: STATUS_META[s].dot }} />
            {STATUS_META[s].label}
          </button>
        ))}
        <span style={{ width: 1, height: 20, background: "var(--lx-border-default)", margin: "0 4px" }} />
        <select className="prop-input" style={{ height: 24, fontSize: 12, minWidth: 140 }} value={slug} onChange={(e) => reset({ slug: e.target.value })}>
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.slug}>{p.name}</option>
          ))}
        </select>
        <select className="prop-input" style={{ height: 24, fontSize: 12, minWidth: 130 }} value={skillId} onChange={(e) => reset({ skillId: e.target.value })}>
          <option value="">All skills</option>
          {(skills.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {history.isLoading ? (
        <div className="mt-8" style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ height: 16, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "45%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "70%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "55%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "62%" }} />
        </div>
      ) : history.isError ? (
        <div className="mt-8" style={{ background: "var(--lx-bg-danger-subtle)", border: "1px solid rgba(255,68,68,0.25)", borderRadius: 8, padding: "16px 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-danger)", flexShrink: 0 }}>
            <path d="M12 9v4m0 4h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="text-sm weight-500 color-primary">Could not load Forge history</div>
            <div className="text-xs color-secondary">The server may be unreachable. Check that the daemon and API are running.</div>
          </div>
          <button type="button" className="btn btn-ghost" style={{ height: 28, padding: "0 12px", fontSize: 12, flexShrink: 0 }} onClick={() => history.refetch()}>
            Retry
          </button>
        </div>
      ) : page.length === 0 ? (
        <div className="empty-box mt-8" style={{ padding: 24 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-muted)" }}>
            <path d="m15 12-8.373 8.373a2.121 2.121 0 1 1-3-3L12 9m7-4 .65-.65a2.121 2.121 0 1 1 3 3L19.003 11M15 5l2 2" />
            <path d="M6 18 2 22" />
          </svg>
          <div className="text-sm weight-500 color-primary">
            {status || slug || skillId ? "No runs match the current filters" : cursor !== null ? "No older runs" : "No Forge runs yet"}
          </div>
          <p className="text-xs color-secondary" style={{ maxWidth: 380 }}>
            {status || slug || skillId
              ? "Try widening the filters — for example by clearing the status chip or choosing another project."
              : cursor !== null
                ? "You've reached the end of the run history."
                : "Forge tasks are created from the editor toolbar in any task or wiki page. Open a document and press the Forge button to start your first run."}
          </p>
        </div>
      ) : (
        <div style={{ background: "var(--lx-surface-card)", border: "1px solid var(--lx-border-default)", borderRadius: 8, overflow: "hidden" }}>
          <table className="settings-table">
            <thead>
              <tr>
                <th style={{ width: "auto" }}>Task</th>
                <th>Project</th>
                <th>Runtime</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th style={{ width: 44 }}></th>
              </tr>
            </thead>
            <tbody>
              {page.map((t) => {
                const isActive = t.status === "queued" || t.status === "running";
                return (
                  <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSelectedId(t.id)}>
                    <td>
                      <div className="text-sm weight-500 color-primary">
                        {t.skillName || t.skillId} · "{t.documentTitle}"
                      </div>
                      <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
                        <span className="font-mono text-2xs color-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.id}</span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label="Copy task id"
                          title={copiedId === t.id ? "Copied" : "Copy task id"}
                          style={{ width: 18, height: 18, flexShrink: 0 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            copyTaskId(t.id);
                          }}
                        >
                          {copiedId === t.id ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={1.5} />}
                        </button>
                      </div>
                    </td>
                    <td className="text-xs color-secondary">{t.projectName || "—"}</td>
                    <td className="text-xs color-secondary">{runtimeName(t.runtimeId)}</td>
                    <td>
                      {isActive ? (
                        <span className="flex items-center gap-2">
                          <span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} />
                          <span className={cn("font-micro text-2xs", STATUS_META[t.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {STATUS_META[t.status].label}
                          </span>
                        </span>
                      ) : (
                        <span className={cn("font-micro text-2xs", STATUS_META[t.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          {STATUS_META[t.status].label}
                        </span>
                      )}
                    </td>
                    <td className="text-xs color-secondary">{formatDayTime(t.startedAt)}</td>
                    <td className="text-xs color-secondary">{formatDayTime(t.finishedAt)}</td>
                    <td>
                      {isActive ? (
                        <button type="button"
                          className="btn btn-ghost"
                          aria-label="Cancel task"
                          title="Cancel this Forge task"
                          style={{ width: 26, height: 26, padding: 0 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelTask.mutate(t.id);
                          }}
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      ) : (
                        <ChevronRight size={12} strokeWidth={1.5} style={{ color: "var(--lx-text-muted)" }} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination — stays visible when a cursor is active (even on an empty
          end-of-history page) so Newer is always reachable */}
      {!history.isLoading && !history.isError && (page.length > 0 || cursor !== null || history.data?.nextCursor != null) && (
        <div className="flex items-center justify-between mt-3" style={{ gap: 12 }}>
          <span className="text-xs color-muted">{page.length > 0 ? `Showing ${page.length} runs` : "End of history"}</span>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-ghost" disabled={cursor === null} style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setCursor(null)}>
              ← Newer
            </button>
            <button type="button" className="btn btn-ghost" disabled={!history.data?.nextCursor} style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => history.data?.nextCursor && setCursor(history.data.nextCursor)}>
              Older →
            </button>
          </div>
        </div>
      )}

      {/* Slideover: task record */}
      {selectedId !== null && portalTarget !== null &&
        createPortal(
          <>
            <div className="slideover-overlay" onClick={() => setSelectedId(null)} />
            <div className="slideover" role="dialog" aria-modal="true" style={{ width: 520 }}>
              <div className="slideover-header border-b border-lx-border-subtle">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-lx-text-muted font-body">
                    {detail ? `${detail.projectName || "Forge"} / ${detail.documentType === "wiki" ? "Wiki" : "Tasks"}` : "Forge"}
                  </span>
                </div>
                <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={() => setSelectedId(null)} aria-label="Close">
                  <X size={18} strokeWidth={1.5} />
                </button>
              </div>

              {detail ? (
                <>
                  <div className="px-4 pt-4">
                    <h2 className="slideover-title">
                      {detail.skillName || detail.skillId} · "{detail.documentTitle}"
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Task {detail.id.slice(0, 6)}</span>
                      <span className={cn("font-micro text-2xs", STATUS_META[detail.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {STATUS_META[detail.status].label} · {durationLabel(detail)}
                      </span>
                    </div>
                  </div>

                  {/* Task meta */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", padding: "16px 16px 0" }}>
                    <div>
                      <span className="prop-label">Document</span>
                      <div className="text-sm color-primary">{detail.documentTitle}</div>
                      <Link to={openDocumentPath(detail, detailProjectSlug)} style={{ fontSize: 12, color: "var(--lx-text-link)", textDecoration: "none" }} onClick={() => setSelectedId(null)}>
                        Open document →
                      </Link>
                    </div>
                    <div>
                      <span className="prop-label">Skill</span>
                      <div className="text-sm color-primary">{detail.skillName || detail.skillId}</div>
                    </div>
                    <div>
                      <span className="prop-label">Runtime</span>
                      <div className="text-sm color-primary">{detail.runtimeId ? runtimeName(detail.runtimeId) : "—"}</div>
                      {detail.runtimeId && (
                        <div className="font-mono text-2xs color-muted">
                          {(() => {
                            const r = runtimes.data?.find((x) => x.id === detail.runtimeId);
                            return r ? `${r.provider} · ${r.model}` : "";
                          })()}
                        </div>
                      )}
                    </div>
                    <div>
                      <span className="prop-label">Timeline</span>
                      <div className="text-xs color-secondary">{timelineLabel(detail)}</div>
                    </div>
                  </div>

                  {/* Activity log — live while queued/running, static once finished */}
                  <div className="slideover-body">
                    <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                      <span className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Activity</span>
                      <button type="button" className="btn btn-ghost" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={() => setLogModalOpen(true)}>
                        <Maximize size={11} strokeWidth={1.5} />
                        <span style={{ marginLeft: 5 }}>Expand</span>
                      </button>
                    </div>
                    <div className="forge-task-log">
                      <div className="forge-task-log-head">
                        <span className="forge-task-log-live">
                          <span className="forge-task-log-dot" />
                          {detail.status === "queued" || detail.status === "running" ? "Live" : "Log"}
                        </span>
                      </div>
                      <div className="forge-task-log-body">
                        {(logs.data ?? []).map((line, i) => (
                          <div key={line.id} className={cn("forge-task-log-line", i === (logs.data?.length ?? 0) - 1 && "current")}>
                            <span className="forge-task-log-dot" aria-hidden="true">●</span>
                            <span className="forge-task-log-time">{formatLogTime(line.createdAt)}</span>
                            <span className="forge-task-log-msg">{line.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Result (completed) */}
                    {detail.status === "completed" && (
                      <>
                        <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Result</div>
                        <div style={{ background: "var(--lx-bg-success-subtle)", border: "1px solid rgba(74,222,128,0.25)", borderRadius: 6, padding: "12px 16px", fontSize: 14, lineHeight: "22px", color: "var(--lx-text-primary)", whiteSpace: "pre-wrap", fontFamily: "var(--lx-font-body)" }}>
                          {detail.result || "No result returned."}
                        </div>
                      </>
                    )}

                    {/* Failure details */}
                    {detail.status === "failed" && (
                      <>
                        <div className="font-micro text-2xs color-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Error</div>
                        <div className="border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default">
                          {detail.error || "Task failed without an error message."}
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="slideover-body flex items-center justify-center" style={{ flexDirection: "column", gap: 12 }}>
                  <div className="empty-state-icon">
                    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4M12 16h.01" />
                    </svg>
                  </div>
                  <div className="empty-state-title">Task not found</div>
                  <div className="empty-state-desc">This Forge task was deleted or is no longer visible.</div>
                  <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setSelectedId(null)}>
                    Close
                  </button>
                </div>
              )}
            </div>
          </>,
          portalTarget
        )}
      </main>

      <ForgeTaskLogModal
        open={logModalOpen}
        onClose={() => setLogModalOpen(false)}
        task={detail}
        logs={logs.data ?? []}
        runtimes={runtimes.data}
      />
    </>
  );
}
