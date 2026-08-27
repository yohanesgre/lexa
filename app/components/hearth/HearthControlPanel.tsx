import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Copy, LayoutGrid, Maximize, X } from "lucide-react";
import { Link, useSearch } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { cn } from "../ui/cn";
import { parseApiDate } from "../../lib/date";
import { copyToClipboard } from "../../lib/clipboard";
import { MarkdownContent } from "../../lib/markdownToReact";
import { useCancelHearthTask, useHearthTask, useHearthTaskHistory, useHearthTaskLogs, useSkills, useProjects, useRuntimes, useSession } from "../../lib/queries";
import { HearthTaskLogModal } from "./HearthTaskLogModal";
import { classifyLogLine } from "../../lib/hearth-log-line";
import type { HearthTask, HearthTaskLog, HearthTaskStatus, Runtime } from "../../../shared/types";

const STATUS_ORDER: HearthTaskStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

const STATUS_META: Record<HearthTaskStatus, { label: string; color: string; dot: string; tint: string }> = {
  queued: { label: "Queued", color: "text-lx-text-warning", dot: "var(--lx-text-warning)", tint: "var(--lx-bg-warning-subtle)" },
  running: { label: "Running", color: "text-lx-text-warning", dot: "var(--lx-text-warning)", tint: "var(--lx-bg-warning-subtle)" },
  completed: { label: "Done", color: "text-lx-text-success", dot: "var(--lx-text-success)", tint: "var(--lx-bg-success-subtle)" },
  failed: { label: "Failed", color: "text-lx-text-danger", dot: "var(--lx-text-danger)", tint: "var(--lx-bg-danger-subtle)" },
  cancelled: { label: "Cancelled", color: "text-lx-text-muted", dot: "var(--lx-text-muted)", tint: "var(--lx-surface-selected)" },
};

const USER_TIME_ZONE = typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
const LOG_TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: USER_TIME_ZONE });

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

function durationLabel(task: HearthTask): string {
  const start = task.startedAt ? parseApiDate(task.startedAt).getTime() : null;
  const end = task.finishedAt ? parseApiDate(task.finishedAt).getTime() : null;
  const ms = end !== null && start !== null ? end - start : task.status === "running" && start !== null ? Date.now() - start : null;
  if (ms === null || Number.isNaN(ms) || ms < 0) return STATUS_META[task.status].label;
  const min = ms / 60000;
  return min < 1 ? `${Math.max(1, Math.round(min * 60))}s` : `${min.toFixed(1)} min`;
}

function timelineLabel(task: HearthTask): string {
  if (!task.startedAt) return `Created ${formatLogTime(task.createdAt)}`;
  if (!task.finishedAt) return `Created ${formatLogTime(task.createdAt)} · Started ${formatLogTime(task.startedAt)}`;
  return `Created ${formatLogTime(task.createdAt)} · Started ${formatLogTime(task.startedAt)} · Finished ${formatLogTime(task.finishedAt)}`;
}

function openDocumentPath(task: HearthTask, projectSlug: string | undefined): string {
  // The task document surface is the board (task detail slideover opens via
  // the ?task= search param); wiki pages are their own route.
  return task.documentType === "wiki" ? `/${projectSlug ?? ""}/wiki/${task.documentId}` : `/${projectSlug ?? ""}/?task=${task.documentId}`;
}

function SummaryStrip({ summary, activeCount, online, total }: {
  summary: Record<HearthTaskStatus, number> | undefined;
  activeCount: number;
  online: number;
  total: number;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 16 }}>
      <div className="card-row">
        <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Active</div>
        <div className="font-display text-xl weight-600 text-lx-text-warning" style={{ lineHeight: 1.2 }}>
          {summary ? activeCount : "—"}
          <span className="font-micro text-2xs text-lx-text-muted" style={{ marginLeft: 6 }}>
            {(summary?.running ?? 0) > 0 ? "running" : (summary?.queued ?? 0) > 0 ? "queued" : "idle"}
          </span>
        </div>
      </div>
      <div className="card-row">
        <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Queued</div>
        <div className="font-display text-xl weight-600 text-lx-text-primary" style={{ lineHeight: 1.2 }}>{summary ? summary.queued : "—"}</div>
      </div>
      <div className="card-row">
        <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Done</div>
        <div className="font-display text-xl weight-600 text-lx-text-success" style={{ lineHeight: 1.2 }}>{summary ? summary.completed : "—"}</div>
      </div>
      <div className="card-row">
        <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Failed</div>
        <div className="font-display text-xl weight-600 text-lx-text-danger" style={{ lineHeight: 1.2 }}>{summary ? summary.failed : "—"}</div>
      </div>
      <div className="card-row">
        <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Runtimes</div>
        <div className="font-display text-xl weight-600 text-lx-text-primary" style={{ lineHeight: 1.2 }}>
          {total > 0 ? online : "—"}
          {total > 0 && <span className="font-micro text-2xs text-lx-text-muted" style={{ marginLeft: 6 }}>/ {total} online</span>}
        </div>
      </div>
    </div>
  );
}

function FilterBar({ status, slug, skillId, projects, skills, onReset }: {
  status: HearthTaskStatus | null;
  slug: string;
  skillId: string;
  projects: { data?: { id: string; slug: string; name: string }[] | undefined };
  skills: { data?: { id: string; name: string }[] | undefined };
  onReset: (patch: Partial<{ status: HearthTaskStatus | null; slug: string; skillId: string }>) => void;
}) {
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginBottom: 12 }}>
      <button
        type="button"
        className="status-chip"
        aria-pressed={status === null}
        style={status === null ? { background: "var(--lx-surface-selected)", borderColor: "var(--lx-border-focus)", color: "var(--lx-text-primary)" } : undefined}
        onClick={() => onReset({ status: null })}
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
          onClick={() => onReset({ status: s })}
        >
          <span className="status-dot" style={{ background: STATUS_META[s].dot }} />
          {STATUS_META[s].label}
        </button>
      ))}
      <span style={{ width: 1, height: 20, background: "var(--lx-border-default)", margin: "0 4px" }} />
      <select className="prop-input" aria-label="Filter by project" style={{ height: 24, fontSize: 12, minWidth: 140 }} value={slug} onChange={(e) => onReset({ slug: e.target.value })}>
        <option value="">All projects</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.slug}>{p.name}</option>
        ))}
      </select>
      <select className="prop-input" aria-label="Filter by skill" style={{ height: 24, fontSize: 12, minWidth: 130 }} value={skillId} onChange={(e) => onReset({ skillId: e.target.value })}>
        <option value="">All skills</option>
        {(skills.data ?? []).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}

function HistoryTable({ tasks, copiedId, onCopyId, onSelect, onCancel, runtimeName }: {
  tasks: (HearthTask & { projectName?: string })[];
  copiedId: string | null;
  onCopyId: (id: string) => void;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
  runtimeName: (id: string | null) => string;
}) {
  return (
    <div className="card-panel" style={{ overflow: "hidden" }}>
      <table className="settings-table">
        <thead>
          <tr>
            <th style={{ width: "auto" }}>Task</th>
            <th>Project</th>
            <th>Runtime</th>
            <th>Type</th>
            <th>Status</th>
            <th>Started</th>
            <th>Finished</th>
            <th style={{ width: 44 }}></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const isActive = t.status === "queued" || t.status === "running";
            return (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => onSelect(t.id)}>
                <td>
                  <div className="text-sm weight-500 text-lx-text-primary">
                    {t.skillName || t.skillId} · "{t.documentTitle}"
                  </div>
                  <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
                    <span className="font-mono text-2xs text-lx-text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.id}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Copy task id"
                      title={copiedId === t.id ? "Copied" : "Copy task id"}
                      style={{ width: 18, height: 18, flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopyId(t.id);
                      }}
                    >
                      {copiedId === t.id ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={1.5} />}
                    </button>
                  </div>
                </td>
                <td className="text-xs text-lx-text-secondary">{t.projectName || "—"}</td>
                <td className="text-xs text-lx-text-secondary">{runtimeName(t.runtimeId)}</td>
                <td className="text-xs text-lx-text-secondary">{t.kind === "blacksmith" ? "Blacksmith" : "Herald"}</td>
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
                <td className="text-xs text-lx-text-secondary">{formatDayTime(t.startedAt)}</td>
                <td className="text-xs text-lx-text-secondary">{formatDayTime(t.finishedAt)}</td>
                <td>
                  {isActive ? (
                    <button type="button"
                      className="btn btn-ghost"
                      aria-label="Cancel task"
                      title="Cancel this Hearth task"
                      style={{ width: 26, height: 26, padding: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel(t.id);
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
  );
}

function TaskDetailSlideover({ detail, detailProjectSlug, runtimes, logs, canViewDetails, runtimeName, onClose, onExpandLogs }: {
  detail: (HearthTask & { projectName?: string }) | null;
  detailProjectSlug: string | undefined;
  runtimes: Runtime[];
  logs: HearthTaskLog[] | undefined;
  // Detail internals (activity feed, result text, failure details) are
  // ADMIN-GATED — members get the meta grid + status rows only.
  canViewDetails: boolean;
  runtimeName: (id: string | null) => string;
  onClose: () => void;
  onExpandLogs: () => void;
}) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onClose} aria-label="Close" />
      <dialog open className="slideover" aria-modal="true" aria-label="Hearth task details" style={{ width: 520 }}>
        <div className="slideover-header border-b border-lx-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-xs text-lx-text-muted font-body">
              {detail ? `${detail.projectName || "Hearth"} / ${detail.documentType === "wiki" ? "Wiki" : "Tasks"}` : "Hearth"}
            </span>
          </div>
          <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={onClose} aria-label="Close">
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
                <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Task {detail.id.slice(0, 6)}</span>
                <span className={cn("font-micro text-2xs", STATUS_META[detail.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {STATUS_META[detail.status].label} · {durationLabel(detail)}
                </span>
              </div>
            </div>

            {/* Task meta */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", padding: "16px 16px 0" }}>
              <div>
                <span className="prop-label">Document</span>
                <div className="text-sm text-lx-text-primary">{detail.documentTitle}</div>
                <Link to={openDocumentPath(detail, detailProjectSlug)} style={{ fontSize: 12, color: "var(--lx-text-link)", textDecoration: "none" }} onClick={onClose}>
                  Open document →
                </Link>
              </div>
              <div>
                <span className="prop-label">Skill</span>
                <div className="text-sm text-lx-text-primary">{detail.skillName || detail.skillId}</div>
              </div>
              <div>
                <span className="prop-label">Type</span>
                <div className="text-sm text-lx-text-primary">{detail.kind === "blacksmith" ? "Blacksmith" : "Herald"}</div>
              </div>
              <div>
                <span className="prop-label">Runtime</span>
                <div className="text-sm text-lx-text-primary">{detail.runtimeId ? runtimeName(detail.runtimeId) : "—"}</div>
                {detail.runtimeId && (
                  <div className="font-mono text-2xs text-lx-text-muted">
                    {(() => {
                      const r = runtimes.find((x) => x.id === detail.runtimeId);
                      return r ? `${r.provider} · ${r.model}` : "";
                    })()}
                  </div>
                )}
              </div>
              <div>
                <span className="prop-label">Timeline</span>
                <div className="text-xs text-lx-text-secondary">{timelineLabel(detail)}</div>
              </div>
            </div>

            {/* Activity log — live while queued/running, static once finished.
                ADMIN-GATED detail internal. */}
            <div className="slideover-body">
              {canViewDetails && (
              <>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Activity</span>
                <button type="button" className="btn btn-ghost" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={onExpandLogs}>
                  <Maximize size={11} strokeWidth={1.5} />
                  <span style={{ marginLeft: 5 }}>Expand</span>
                </button>
              </div>
              <div className="hearth-task-log">
                <div className="hearth-task-log-head">
                  {(() => {
                    const logActive = detail.status === "queued" || detail.status === "running";
                    const count = logs?.length ?? 0;
                    return (
                      <span className={cn("hearth-task-log-live", !logActive && "is-static")}>
                        {logActive ? "Live" : "Log"} · {count} {count === 1 ? "line" : "lines"}
                      </span>
                    );
                  })()}
                </div>
                {(logs?.length ?? 0) === 0 ? (
                  <div className="hearth-task-log-empty">
                    {detail.status === "queued" ? "Queued — waiting for a runtime to claim it." : "No activity recorded for this task."}
                  </div>
                ) : (
                  <div className="hearth-task-log-body">
                    {(logs ?? []).map((line, i) => {
                      const { level, display } = classifyLogLine(line);
                      const isLast = i === (logs?.length ?? 0) - 1;
                      return (
                        <div key={line.id} className={cn("hearth-task-log-line", level === "error" && "stderr", level === "warn" && "warn", (detail.status === "queued" || detail.status === "running") && isLast && "current")}>
                          <span className="hearth-task-log-dot" aria-hidden="true">{level === "info" ? "●" : "!"}</span>
                          <span className="hearth-task-log-time">{formatLogTime(line.createdAt)}</span>
                          <span className="hearth-task-log-msg">{display}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Result (completed) — ADMIN-GATED detail internal */}
              {canViewDetails && detail.status === "completed" && (
                <>
                  <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Result</div>
                  <div className="hearth-result-card hearth-result-md">
                    <MarkdownContent md={detail.result || "No result returned."} />
                  </div>
                </>
              )}

              {/* Failure details — ADMIN-GATED detail internal */}
              {canViewDetails && detail.status === "failed" && (
                <>
                  <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Error</div>
                  <div className="border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default">
                    {detail.error || "Task failed without an error message."}
                  </div>
                </>
              )}
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
            <div className="empty-state-desc">This Hearth task was deleted or is no longer visible.</div>
            <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}

export function HearthControlPanel({ embedded = false }: { embedded?: boolean }) {
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  // ?task=<id> deep-link (navbar Hearth dropdown rows) — opens the record.
  const search = useSearch({ from: "/hearth/runs" });
  const [status, setStatus] = useState<HearthTaskStatus | null>(null);
  const [slug, setSlug] = useState("");
  const [skillId, setSkillId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (search.task) setSelectedId(search.task);
  }, [search.task]);

  const skills = useSkills();
  const history = useHearthTaskHistory({ ...(slug ? { slug } : {}), ...(status ? { status } : {}), ...(skillId ? { skillId } : {}) }, cursor);
  const runtimes = useRuntimes();
  const projects = useProjects();
  const selected = useHearthTask(selectedId, selectedId !== null);
  // Log internals are ADMIN-GATED — members never fetch the feed (403).
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "superadmin";
  const logs = useHearthTaskLogs(selectedId, selectedId !== null && isAdmin);
  const cancelTask = useCancelHearthTask();

  const page = history.data?.data ?? [];
  const summary = history.data?.summary;
  const online = runtimes.data?.filter((r) => r.status === "online").length ?? 0;
  const total = runtimes.data?.length ?? 0;

  const reset = (next: { slug?: string | undefined; status?: HearthTaskStatus | null; skillId?: string }) => {
    if (next.slug !== undefined) setSlug(next.slug);
    if (next.status !== undefined) setStatus(next.status ?? null);
    if (next.skillId !== undefined) setSkillId(next.skillId);
    setCursor(null);
  };

  const runtimeName = (id: string | null): string => {
    if (!id) return "—";
    return runtimes.data?.find((r) => r.id === id)?.name ?? "—";
  };

  // Copy the task id to the clipboard (for debugging — daemon logs, API).
  // Shows a transient check on the row, like the navbar panel.
  const copyTaskId = (id: string) => {
    void copyToClipboard(id).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    });
  };

  const row = page.find((t) => t.id === selectedId) ?? null;
  const detail = (selected.data ?? row ?? null) as (HearthTask & { projectName?: string }) | null;
  const detailProjectSlug = detail ? projects.data?.find((p) => p.id === detail.projectId)?.slug : undefined;

  const activeCount = (summary?.queued ?? 0) + (summary?.running ?? 0);

  const header = !embedded ? (
    <>
      <div className="flex items-center justify-between mb-3">
        <h1 className="font-display text-2xl weight-600 text-lx-text-primary mb-0">Hearth</h1>
        <div className="flex items-center gap-3">
          <Link to="/hearth/runtimes" className="btn btn-ghost" style={{ height: 28, padding: "0 12px", fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <LayoutGrid size={14} strokeWidth={1.5} />
            Hearth runtimes
          </Link>
        </div>
      </div>
      <p className="text-sm text-lx-text-secondary mb-4" style={{ maxWidth: 560 }}>
        Every AI writing-assist run across all projects, newest first. Rows open the task record: activity feed, result, and failure details.
      </p>
    </>
  ) : null;

  const body = (
    <>
      {header}

      {/* Summary strip — counts ride the history response (no separate aggregate endpoint) */}
      <SummaryStrip summary={summary} activeCount={activeCount} online={online} total={total} />

      <FilterBar status={status} slug={slug} skillId={skillId} projects={projects} skills={skills} onReset={reset} />



      {/* Table */}
      {history.isLoading ? (
        <div className="card-panel mt-8" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ height: 16, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "45%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "70%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "55%" }} />
          <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "62%" }} />
        </div>
      ) : history.isError ? (
        <div className="notice notice-danger mt-8">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-danger)", flexShrink: 0 }}>
            <path d="M12 9v4m0 4h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="text-sm weight-500 text-lx-text-primary">Could not load Hearth history</div>
            <div className="text-xs text-lx-text-secondary">The server may be unreachable. Check that the daemon and API are running.</div>
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
          <div className="text-sm weight-500 text-lx-text-primary">
            {status || slug || skillId ? "No runs match the current filters" : cursor !== null ? "No older runs" : "No Hearth runs yet"}
          </div>
          <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
            {status || slug || skillId
              ? "Try widening the filters — for example by clearing the status chip or choosing another project."
              : cursor !== null
                ? "You've reached the end of the run history."
                : "Hearth tasks are created from the editor toolbar in any task or wiki page. Open a document and press the Hearth button to start your first run."}
          </p>
        </div>
      ) : (
      <HistoryTable
        tasks={page}
        copiedId={copiedId}
        onCopyId={copyTaskId}
        onSelect={setSelectedId}
        onCancel={(id) => cancelTask.mutate(id)}
        runtimeName={runtimeName}
      />
      )}


      {/* Pagination — stays visible when a cursor is active (even on an empty
          end-of-history page) so Newer is always reachable */}
      {!history.isLoading && !history.isError && (page.length > 0 || cursor !== null || history.data?.nextCursor != null) && (
        <div className="flex items-center justify-between mt-3" style={{ gap: 12 }}>
          <span className="text-xs text-lx-text-muted">{page.length > 0 ? `Showing ${page.length} runs` : "End of history"}</span>
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
          <TaskDetailSlideover
            detail={detail}
            detailProjectSlug={detailProjectSlug}
            runtimes={runtimes.data ?? []}
            logs={logs.data}
            canViewDetails={isAdmin}
            runtimeName={runtimeName}
            onClose={() => setSelectedId(null)}
            onExpandLogs={() => setLogModalOpen(true)}
          />,
          portalTarget
        )}
    </>
  );

  const inner = (
    <>
      {body}
      {logModalOpen && (
<HearthTaskLogModal
        open={logModalOpen}
        onClose={() => setLogModalOpen(false)}
        task={detail}
        logs={logs.data ?? []}
        runtimes={runtimes.data ?? []}
      />
      )}
    </>
  );

  if (embedded) return inner;
  return <main className="page-frame page-frame-narrow">{inner}</main>;
}

export function HearthRunsContent() {
  return <HearthControlPanel embedded />;
}