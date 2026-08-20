import { useEffect, useRef, useState, useEffectEvent } from "react";
import { Check, Copy, X } from "lucide-react";
import { cn } from "../ui/cn";
import { copyToClipboard } from "../../lib/clipboard";
import { parseApiDate } from "../../lib/date";
import { classifyLogLine } from "../../lib/forge-log-line";
import type { ForgeTask, ForgeTaskLog, ForgeTaskStatus, Runtime } from "../../../shared/types";

const STATUS_META: Record<ForgeTaskStatus, { label: string; color: string }> = {
  queued: { label: "Queued", color: "text-lx-text-warning" },
  running: { label: "Running", color: "text-lx-text-warning" },
  completed: { label: "Completed", color: "text-lx-text-success" },
  failed: { label: "Failed", color: "text-lx-text-danger" },
  cancelled: { label: "Cancelled", color: "text-lx-text-muted" },
};

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC — render the local
// wall-clock time for the log's timestamp column.
const USER_TIME_ZONE = typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
const LOG_TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: USER_TIME_ZONE });

function formatLogTime(iso: string): string {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return LOG_TIME_FMT.format(d);
}

// "HH:MM:SS message" per line — what the Copy button puts on the clipboard.
function logToText(lines: ForgeTaskLog[]): string {
  return lines.map((l) => `${formatLogTime(l.createdAt)} ${l.message}`).join("\n");
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
  const t = (iso: string | null) => (iso ? formatLogTime(iso) : "—");
  return `Created ${t(task.createdAt)} · Started ${t(task.startedAt)} · Finished ${t(task.finishedAt)}`;
}

// Expanded log viewer for a Forge task — same append-only feed as the compact
// .forge-task-log, but full-height with wrapped lines, follow + copy. Shared
// by the editor popover and the control panel slideover (forge-log-modal).
export function ForgeTaskLogModal({
  open,
  onClose,
  task,
  logs,
  runtimes,
}: {
  open: boolean;
  onClose: () => void;
  task: ForgeTask | null;
  logs: ForgeTaskLog[];
  runtimes?: Runtime[];
}) {
  const [followLog, setFollowLog] = useState(true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const active = task?.status === "queued" || task?.status === "running";
  const lines = logs.slice(-400);

  // Follow mode: keep the feed pinned to the newest line while the task runs.
  useEffect(() => {
    if (followLog && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, followLog]);

  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  });
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function handleKeyDown(e: KeyboardEvent) {
      onEscape(e);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open || !task) return null;

  const runtime = runtimes?.find((r) => r.id === task.runtimeId);
  const status = STATUS_META[task.status];

  const handleCopy = () => {
    copyToClipboard(logToText(lines)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter forge-log-modal pointer-events-auto" aria-modal="true" aria-label="Forge task log">
          <div className="modal-header">
            <div style={{ minWidth: 0 }}>
              <div className="modal-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.skillName || task.skillId} · "{task.documentTitle}"
              </div>
              <div className="font-mono text-2xs text-lx-text-muted" style={{ marginTop: 2 }}>
                Task {task.id.slice(0, 6)} · {runtime?.name ?? "—"} · {runtime?.provider ?? "—"} · {runtime?.model ?? "—"}
              </div>
            </div>
            <div className="flex items-center gap-2" style={{ marginLeft: "auto", flexShrink: 0 }}>
              {active && (
                <>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className="font-micro text-2xs uppercase tracking-[0.04em]" style={{ color: "var(--lx-text-muted)" }}>Follow</span>
                    <button
                      type="button"
                      className={cn("btn btn-ghost", followLog && "is-active")}
                      aria-pressed={followLog}
                      aria-label={followLog ? "Pause auto-scroll" : "Resume auto-scroll"}
                      title={followLog ? "Pause auto-scroll" : "Resume auto-scroll"}
                      style={{ height: 20, padding: "0 7px", fontSize: 10, lineHeight: "18px" }}
                      onClick={() => setFollowLog((v) => !v)}
                    >
                      ●
                    </button>
                  </span>
                  <span className="forge-task-log-live" style={{ marginLeft: 8 }}>live</span>
                </>
              )}
              <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 11 }} onClick={handleCopy}>
                {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={1.5} />}
                <span style={{ marginLeft: 5 }}>{copied ? "Copied" : "Copy"}</span>
              </button>
              <button ref={closeRef} type="button" className="btn btn-ghost" style={{ width: 30, height: 30, padding: 0 }} onClick={onClose} aria-label="Close">
                <X size={15} strokeWidth={1.5} />
              </button>
            </div>
          </div>

          <div className="forge-log-modal-body">
            <div className="flex items-center justify-between">
              <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Activity feed · {lines.length} {lines.length === 1 ? "line" : "lines"} · append-only
              </span>
              <span className={cn("font-micro text-2xs", status.color)} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {status.label} · {durationLabel(task)}
              </span>
            </div>
            <div className="forge-task-log forge-task-log-expanded" ref={bodyRef}>
              {lines.length === 0 ? (
                <div className="text-lx-text-muted" style={{ fontFamily: "var(--lx-font-mono)", fontSize: 12.5, lineHeight: "21px" }}>
                  {task.status === "queued" ? "Queued — waiting for a runtime to claim it." : "No activity recorded for this task."}
                </div>
              ) : (
                lines.map((line) => {
                  const { level, display } = classifyLogLine(line);
                  const isLast = line.id === lines[lines.length - 1].id;
                  return (
                    <div key={line.id} className={cn("forge-task-log-line", level === "error" && "stderr", level === "warn" && "warn", active && isLast && "current")}>
                      <span className="forge-task-log-dot" aria-hidden="true">{level === "info" ? "●" : "!"}</span>
                      <span className="forge-task-log-time">{formatLogTime(line.createdAt)}</span>
                      <span className="forge-task-log-msg">{display}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="modal-footer">
            <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {timelineLabel(task)}
            </span>
          </div>
        </dialog>
      </div>
    </>
  );
}
