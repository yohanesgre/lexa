import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { Check, ChevronRight, Copy, LayoutGrid, Maximize, X } from "lucide-react";
import { Link, useSearch } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { cn } from "../ui/cn";
import { parseApiDate } from "../../lib/date";
import { copyToClipboard } from "../../lib/clipboard";
import { MarkdownContent } from "../MarkdownContent";
import { useCancelHearthTask, useHearthTask, useHearthTaskHistory, useHearthTaskLogs, useSkills, useProjects, useRuntimes, useSession } from "../../lib/queries";
import { HearthTaskLogModal } from "./HearthTaskLogModal";
import { TaskNotFoundBody } from "../TaskNotFoundDialog";
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

function runtimeCounts(runtimes: UseQueryResult<Runtime[], unknown>): { online: number; total: number } {
  const data = runtimes.data;
  return {
    online: data?.filter((r) => r.status === "online").length ?? 0,
    total: data?.length ?? 0,
  };
}

function runtimeLabel(data: Runtime[] | undefined, id: string | null): string {
  if (!id) return "—";
  return data?.find((r) => r.id === id)?.name ?? "—";
}

function activeRunCount(summary: Record<HearthTaskStatus, number> | undefined): number {
  return (summary?.queued ?? 0) + (summary?.running ?? 0);
}

function projectSlugFor(projects: { data?: { id: string; slug: string }[] | undefined }, detail: HearthTask | null): string | undefined {
  if (!detail) return undefined;
  return projects.data?.find((p) => p.id === detail.projectId)?.slug;
}

function emptyStateTitle(status: HearthTaskStatus | null, slug: string, skillId: string, cursor: string | null): string {
  const filtered = status !== null || slug !== "" || skillId !== "";
  if (filtered) return "No runs match the current filters";
  if (cursor !== null) return "No older runs";
  return "No Hearth runs yet";
}

function emptyStateHint(status: HearthTaskStatus | null, slug: string, skillId: string, cursor: string | null): string {
  const filtered = status !== null || slug !== "" || skillId !== "";
  if (filtered) return "Try widening the filters — for example by clearing the status chip or choosing another project.";
  if (cursor !== null) return "You've reached the end of the run history.";
  return "Hearth tasks are created from the editor toolbar in any task or wiki page. Open a document and press the Hearth button to start your first run.";
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

interface FilterValues {
  status: HearthTaskStatus | null;
  slug: string;
  skillId: string;
}

function FilterBar({ status, slug, skillId, projects, skills, onReset }: {
  status: HearthTaskStatus | null;
  slug: string;
  skillId: string;
  projects: { data?: { id: string; slug: string; name: string }[] | undefined };
  skills: { data?: { id: string; name: string }[] | undefined };
  onReset: (patch: Partial<FilterValues>) => void;
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

interface HearthTaskRow extends HearthTask {
  projectName?: string;
}

function HistoryTable({ tasks, copiedId, onCopyId, onSelect, onCancel, runtimeName }: {
  tasks: HearthTaskRow[];
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
          {tasks.map((t) => (
            <HistoryRow key={t.id} task={t} copiedId={copiedId} onCopyId={onCopyId} onSelect={onSelect} onCancel={onCancel} runtimeName={runtimeName} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({ task, copiedId, onCopyId, onSelect, onCancel, runtimeName }: {
  task: HearthTaskRow;
  copiedId: string | null;
  onCopyId: (id: string) => void;
  onSelect: (id: string) => void;
  onCancel: (id: string) => void;
  runtimeName: (id: string | null) => string;
}) {
  const isActive = task.status === "queued" || task.status === "running";
  return (
    <tr style={{ cursor: "pointer" }} onClick={() => onSelect(task.id)}>
      <td>
        <div className="text-sm weight-500 text-lx-text-primary">
          {task.skillName || task.skillId} · "{task.documentTitle}"
        </div>
        <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
          <span className="font-mono text-2xs text-lx-text-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.id}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Copy task id"
            title={copiedId === task.id ? "Copied" : "Copy task id"}
            style={{ width: 18, height: 18, flexShrink: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onCopyId(task.id);
            }}
          >
            {copiedId === task.id ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={1.5} />}
          </button>
        </div>
      </td>
      <td className="text-xs text-lx-text-secondary">{task.projectName || "—"}</td>
      <td className="text-xs text-lx-text-secondary">{runtimeName(task.runtimeId)}</td>
      <td className="text-xs text-lx-text-secondary">{task.kind === "blacksmith" ? "Blacksmith" : "Herald"}</td>
      <td>
        {isActive ? (
          <span className="flex items-center gap-2">
            <span className="spinner" style={{ width: 9, height: 9, borderWidth: 2 }} />
            <span className={cn("font-micro text-2xs", STATUS_META[task.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {STATUS_META[task.status].label}
            </span>
          </span>
        ) : (
          <span className={cn("font-micro text-2xs", STATUS_META[task.status].color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {STATUS_META[task.status].label}
          </span>
        )}
      </td>
      <td className="text-xs text-lx-text-secondary">{formatDayTime(task.startedAt)}</td>
      <td className="text-xs text-lx-text-secondary">{formatDayTime(task.finishedAt)}</td>
      <td>
        {isActive ? (
          <button type="button"
            className="btn btn-ghost"
            aria-label="Cancel task"
            title="Cancel this Hearth task"
            style={{ width: 26, height: 26, padding: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              onCancel(task.id);
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
}

function DetailCrumb({ detail }: { detail: HearthTaskRow | null }) {
  const label = detail
    ? `${detail.projectName || "Hearth"} / ${detail.documentType === "wiki" ? "Wiki" : "Tasks"}`
    : "Hearth";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-lx-text-muted font-body">{label}</span>
    </div>
  );
}

function DetailRuntime({ detail, runtimes, runtimeName }: {
  detail: HearthTaskRow;
  runtimes: Runtime[];
  runtimeName: (id: string | null) => string;
}) {
  const r = runtimes.find((x) => x.id === detail.runtimeId);
  return (
    <div>
      <span className="prop-label">Runtime</span>
      <div className="text-sm text-lx-text-primary">{detail.runtimeId ? runtimeName(detail.runtimeId) : "—"}</div>
      {detail.runtimeId && (
        <div className="font-mono text-2xs text-lx-text-muted">
          {r ? `${r.provider} · ${r.model}` : ""}
        </div>
      )}
    </div>
  );
}

function TaskLogFeed({ detail, logs }: {
  detail: HearthTaskRow;
  logs: HearthTaskLog[] | undefined;
}) {
  const logActive = detail.status === "queued" || detail.status === "running";
  const lines = logs ?? [];
  return (
    <div className="hearth-task-log">
      <div className="hearth-task-log-head">
        <span className={cn("hearth-task-log-live", !logActive && "is-static")}>
          {logActive ? "Live" : "Log"} · {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="hearth-task-log-empty">
          {detail.status === "queued" ? "Queued — waiting for a runtime to claim it." : "No activity recorded for this task."}
        </div>
      ) : (
        <div className="hearth-task-log-body">
          {lines.map((line, i) => {
            const { level, display } = classifyLogLine(line);
            const isLast = i === lines.length - 1;
            return (
              <div key={line.id} className={cn("hearth-task-log-line", level === "error" && "stderr", level === "warn" && "warn", logActive && isLast && "current")}>
                <span className="hearth-task-log-dot" aria-hidden="true">{level === "info" ? "●" : "!"}</span>
                <span className="hearth-task-log-time">{formatLogTime(line.createdAt)}</span>
                <span className="hearth-task-log-msg">{display}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Detail internals (activity feed, result text, failure details) are
// ADMIN-GATED — members get the meta grid + status rows only.
function DetailActivity({ detail, logs, canViewDetails, onExpandLogs }: {
  detail: HearthTaskRow;
  logs: HearthTaskLog[] | undefined;
  canViewDetails: boolean;
  onExpandLogs: () => void;
}) {
  if (!canViewDetails) return null;
  return (
    <>
      <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
        <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Activity</span>
        <button type="button" className="btn btn-ghost" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={onExpandLogs}>
          <Maximize size={11} strokeWidth={1.5} />
          <span style={{ marginLeft: 5 }}>Expand</span>
        </button>
      </div>
      <TaskLogFeed detail={detail} logs={logs} />

      {/* Result (completed) — ADMIN-GATED detail internal */}
      {detail.status === "completed" && (
        <>
          <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Result</div>
          <div className="hearth-result-card hearth-result-md">
            <MarkdownContent md={detail.result || "No result returned."} />
          </div>
        </>
      )}

      {/* Failure details — ADMIN-GATED detail internal */}
      {detail.status === "failed" && (
        <>
          <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em", margin: "16px 0 8px" }}>Error</div>
          <div className="border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default">
            {detail.error || "Task failed without an error message."}
          </div>
        </>
      )}
    </>
  );
}

function TaskDetailSlideover({ detail, detailProjectSlug, runtimes, logs, canViewDetails, runtimeName, onClose, onExpandLogs }: {
  detail: HearthTaskRow | null;
  detailProjectSlug: string | undefined;
  runtimes: Runtime[];
  logs: HearthTaskLog[] | undefined;
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
          <DetailCrumb detail={detail} />
          <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {detail === null ? (
          <TaskNotFoundBody message="This Hearth task was deleted or is no longer visible." onClose={onClose} />
        ) : (
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
              <DetailRuntime detail={detail} runtimes={runtimes} runtimeName={runtimeName} />
              <div>
                <span className="prop-label">Timeline</span>
                <div className="text-xs text-lx-text-secondary">{timelineLabel(detail)}</div>
              </div>
            </div>

            {/* Activity log — live while queued/running, static once finished. */}
            <div className="slideover-body">
              <DetailActivity detail={detail} logs={logs} canViewDetails={canViewDetails} onExpandLogs={onExpandLogs} />
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

function HistoryStates({ history, page, filters, cursor, children }: {
  history: UseQueryResult<{ data: HearthTaskRow[]; summary?: Record<HearthTaskStatus, number>; nextCursor?: string | null }, unknown>;
  page: HearthTaskRow[];
  filters: FilterValues;
  cursor: string | null;
  children: ReactNode;
}) {
  if (history.isLoading) {
    return (
      <div className="card-panel mt-8" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ height: 16, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "45%" }} />
        <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "70%" }} />
        <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "55%" }} />
        <div style={{ height: 12, borderRadius: 4, background: "var(--lx-surface-elevated)", width: "62%" }} />
      </div>
    );
  }
  if (history.isError) {
    return (
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
    );
  }
  if (page.length === 0) {
    return (
      <div className="empty-box mt-8" style={{ padding: 24 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--lx-text-muted)" }}>
          <path d="m15 12-8.373 8.373a2.121 2.121 0 1 1-3-3L12 9m7-4 .65-.65a2.121 2.121 0 1 1 3 3L19.003 11M15 5l2 2" />
          <path d="M6 18 2 22" />
        </svg>
        <div className="text-sm weight-500 text-lx-text-primary">
          {emptyStateTitle(filters.status, filters.slug, filters.skillId, cursor)}
        </div>
        <p className="text-xs text-lx-text-secondary" style={{ maxWidth: 380 }}>
          {emptyStateHint(filters.status, filters.slug, filters.skillId, cursor)}
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

function PaginationBar({ history, page, cursor, setCursor }: {
  history: UseQueryResult<{ data: HearthTaskRow[]; summary?: Record<HearthTaskStatus, number>; nextCursor?: string | null }, unknown>;
  page: HearthTaskRow[];
  cursor: string | null;
  setCursor: (cursor: string | null) => void;
}) {
  const nextCursor = history.data?.nextCursor;
  const visible = !history.isLoading && !history.isError && (page.length > 0 || cursor !== null || nextCursor != null);
  if (!visible) return null;
  return (
    <div className="flex items-center justify-between mt-3" style={{ gap: 12 }}>
      <span className="text-xs text-lx-text-muted">{page.length > 0 ? `Showing ${page.length} runs` : "End of history"}</span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-ghost" disabled={cursor === null} style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => setCursor(null)}>
          ← Newer
        </button>
        <button type="button" className="btn btn-ghost" disabled={!nextCursor} style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => nextCursor && setCursor(nextCursor)}>
          Older →
        </button>
      </div>
    </div>
  );
}

function useHearthRunsData(filters: { slug: string; status: HearthTaskStatus | null; skillId: string }, cursor: string | null, selectedId: string | null) {
  const skills = useSkills();
  const history = useHearthTaskHistory(
    {
      ...(filters.slug ? { slug: filters.slug } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.skillId ? { skillId: filters.skillId } : {}),
    },
    cursor
  );
  const runtimes = useRuntimes();
  const projects = useProjects();
  const selected = useHearthTask(selectedId, selectedId !== null);
  // Log internals are ADMIN-GATED — members never fetch the feed (403).
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "superadmin";
  const logs = useHearthTaskLogs(selectedId, selectedId !== null && isAdmin);
  const cancelTask = useCancelHearthTask();
  return { skills, history, runtimes, projects, selected, isAdmin, logs, cancelTask };
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

  const { skills, history, runtimes, projects, selected, isAdmin, logs, cancelTask } = useHearthRunsData({ slug, status, skillId }, cursor, selectedId);
  const runtimesData = runtimes.data ?? [];
  const { online, total } = runtimeCounts(runtimes);

  const page = history.data?.data ?? [];
  const summary = history.data?.summary;
  const activeCount = activeRunCount(summary);

  const reset = (next: { slug?: string | undefined; status?: HearthTaskStatus | null; skillId?: string }) => {
    if (next.slug !== undefined) setSlug(next.slug);
    if (next.status !== undefined) setStatus(next.status ?? null);
    if (next.skillId !== undefined) setSkillId(next.skillId);
    setCursor(null);
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
  const detail = (selected.data ?? row ?? null) as HearthTaskRow | null;
  const detailProjectSlug = projectSlugFor(projects, detail);

  const runtimeName = (id: string | null): string => runtimeLabel(runtimesData, id);

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

      <HistoryStates history={history} page={page} filters={{ status, slug, skillId }} cursor={cursor}>
        <HistoryTable
          tasks={page}
          copiedId={copiedId}
          onCopyId={copyTaskId}
          onSelect={setSelectedId}
          onCancel={(id) => cancelTask.mutate(id)}
          runtimeName={runtimeName}
        />
      </HistoryStates>

      {/* Pagination — stays visible when a cursor is active (even on an empty
          end-of-history page) so Newer is always reachable */}
      <PaginationBar history={history} page={page} cursor={cursor} setCursor={setCursor} />

      {/* Slideover: task record */}
      {selectedId !== null && portalTarget !== null &&
        createPortal(
          <TaskDetailSlideover
            detail={detail}
            detailProjectSlug={detailProjectSlug}
            runtimes={runtimesData}
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
        runtimes={runtimesData}
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
