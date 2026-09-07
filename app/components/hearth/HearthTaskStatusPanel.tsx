import { Maximize, Check } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../ui/cn";
import { classifyLogLine } from "../../lib/hearth-log-line";
import { parseApiDate } from "../../lib/date";
import type { HearthTask, HearthTaskLog, Runtime } from "../../../shared/types";

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC — render the local
// wall-clock time for the log's timestamp column.
function formatLogTime(iso: string): string {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function TaskDonePanel({ taskData, failed, reviewActive, dismissedIdsRef, setTaskId, runtimes, onReview }: {
  taskData: HearthTask | null;
  failed: boolean;
  reviewActive: boolean;
  dismissedIdsRef: Set<string>;
  setTaskId: (v: string | null) => void;
  runtimes: Runtime[];
  onReview: (text: string, identity: { action: string; runtimeName: string | null; provider: string | null; taskId: string }) => void;
}) {
  const dismiss = () => {
    if (taskData) dismissedIdsRef.add(taskData.id);
    setTaskId(null);
  };
  return (
    <div style={{ padding: 12 }}>
      {failed ? (
        <div className="border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default">
          {taskData?.error}
        </div>
      ) : (
        <div
          style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}
        >
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <Check size={14} strokeWidth={2.5} className="text-lx-text-success shrink-0" />
            <span className="text-xs font-medium text-lx-text-primary truncate flex-1 min-w-0" style={{ fontFamily: "var(--lx-font-body)" }}>{taskData?.documentTitle || "Document"}</span>
          </div>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ letterSpacing: "0.04em" }}>
            {taskData?.skillName ? `${taskData.skillName} — ready to review` : "Review — ready to review"}
          </span>
        </div>
      )}
      {!failed && (
        <div className="flex items-center justify-end gap-2 mt-3">
          {reviewActive ? (
            <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">In review in editor</span>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={dismiss}>
                Reject
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: 26, padding: "0 10px", fontSize: 12 }}
                onClick={() => {
                  if (taskData?.result) {
                    const runtime = runtimes.find((r) => r.id === taskData.runtimeId);
                    onReview(taskData.result, {
                      action: taskData.skillName || taskData.skillId,
                      runtimeName: runtime?.name ?? null,
                      provider: runtime?.provider ?? null,
                      taskId: taskData.id,
                    });
                  }
                }}
              >
                <Check size={12} strokeWidth={2.5} />
                Review in editor
              </button>
            </>
          )}
        </div>
      )}
      {failed && (
        <div className="flex items-center justify-end mt-3">
          <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={dismiss}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

function TaskRunPanel({ taskData, running, followLog, setFollowLog, logBodyRef, logs, canViewLogs, setLogModalOpen, dismissedIdsRef, cancelTask, setTaskId }: {
  taskData: HearthTask | null;
  running: boolean;
  followLog: boolean;
  setFollowLog: (updater: (prev: boolean) => boolean) => void;
  logBodyRef: React.RefObject<HTMLDivElement | null>;
  logs: { data?: HearthTaskLog[] | undefined };
  canViewLogs: boolean;
  setLogModalOpen: (v: boolean) => void;
  dismissedIdsRef: Set<string>;
  cancelTask: { mutate: (id: string) => void; isPending: boolean };
  setTaskId: (v: string | null) => void;
}) {
  const logLines = (logs.data ?? []).slice(-50);
  // Follow mode: keep the activity log pinned to the newest line while the
  // task runs. The user can pause it (manual scroll) via the Follow toggle.
  useEffect(() => {
    if (followLog && logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [logs.data, followLog, logBodyRef]);
  return (
    <div style={{ padding: "0 12px 12px" }}>
      {running && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
            <span className="text-xs text-lx-text-secondary font-body">
              {taskData?.runtimeId ? "Agent working…" : "Queued…"}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 24, padding: "0 8px", fontSize: 11 }}
            onClick={() => {
              if (taskData) {
                dismissedIdsRef.add(taskData.id);
                cancelTask.mutate(taskData.id);
                setTaskId(null);
              }
            }}
            disabled={cancelTask.isPending}
            title="Cancel this Hearth task — it stops working server-side"
          >
            Cancel
          </button>
        </div>
      )}
      {running && canViewLogs && (
        <div className="hearth-task-log" style={{ marginBottom: 8 }}>
          <div className="slideover-body" style={{ padding: 0 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Activity</span>
              <button type="button" className="btn btn-ghost" style={{ height: 22, padding: "0 8px", fontSize: 11 }} onClick={() => setLogModalOpen(true)} aria-label="Expand log" title="Open the full log viewer">
                <Maximize size={11} strokeWidth={1.5} />
                <span style={{ marginLeft: 5 }}>Expand</span>
              </button>
            </div>
            <div className="hearth-task-log">
              <div className="hearth-task-log-head">
                <span className="hearth-task-log-live">Live · {logLines.length} {logLines.length === 1 ? "line" : "lines"}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className="font-micro text-2xs uppercase tracking-[0.04em] text-lx-text-muted">Follow</span>
                    <button type="button" className={cn("btn btn-ghost", followLog && "is-active")} aria-pressed={followLog} aria-label={followLog ? "Pause auto-scroll" : "Resume auto-scroll"} title={followLog ? "Pause auto-scroll" : "Resume auto-scroll"} style={{ height: 18, padding: "0 6px", fontSize: 10, lineHeight: "16px" }} onClick={() => setFollowLog((v) => !v)}>●</button>
                  </span>
                  <span className="hearth-task-log-live" style={{ marginLeft: 8 }}>live</span>
                </span>
              </div>
              {logLines.length === 0 ? (
                <div className="hearth-task-log-empty">{taskData?.runtimeId ? "Waiting for daemon activity." : "Queued — waiting for a runtime to claim it."}</div>
              ) : (
                <div className="hearth-task-log-body" ref={logBodyRef}>
                  {logLines.map((line, index) => {
                    const { level, display } = classifyLogLine(line);
                    const isLast = index === logLines.length - 1;
                    return (
                      <div key={line.id} className={cn("hearth-task-log-line", level === "error" && "stderr", level === "warn" && "warn", isLast && "current")}>
                        <span className="hearth-task-log-dot" aria-hidden="true">{level === "info" ? "●" : "!"}</span>
                        <span className="hearth-task-log-time">{formatLogTime(line.createdAt)}</span>
                        <span className="hearth-task-log-msg">{display}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function TaskStatusPanel(props: {
  taskId: string;
  taskData: HearthTask | null;
  running: boolean;
  failed: boolean;
  done: boolean;
  reviewActive: boolean;
  followLog: boolean;
  setFollowLog: (updater: (prev: boolean) => boolean) => void;
  logBodyRef: React.RefObject<HTMLDivElement | null>;
  logs: { data?: HearthTaskLog[] | undefined };
  canViewLogs: boolean;
  setLogModalOpen: (v: boolean) => void;
  dismissedIdsRef: Set<string>;
  cancelTask: { mutate: (id: string) => void; isPending: boolean };
  setTaskId: (v: string | null) => void;
  runtimes: Runtime[];
  onReview: (text: string, identity: { action: string; runtimeName: string | null; provider: string | null; taskId: string }) => void;
}) {
  const { taskData, running, failed, done } = props;
  if (done || failed) {
    return <TaskDonePanel taskData={taskData} failed={failed} reviewActive={props.reviewActive} dismissedIdsRef={props.dismissedIdsRef} setTaskId={props.setTaskId} runtimes={props.runtimes} onReview={props.onReview} />;
  }
  return <TaskRunPanel taskData={taskData} running={running} followLog={props.followLog} setFollowLog={props.setFollowLog} logBodyRef={props.logBodyRef} logs={props.logs} canViewLogs={props.canViewLogs} setLogModalOpen={props.setLogModalOpen} dismissedIdsRef={props.dismissedIdsRef} cancelTask={props.cancelTask} setTaskId={props.setTaskId} />;
}
