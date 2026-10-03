import { useState } from "react";
import { AlertCircle, ChevronDown, RefreshCw } from "lucide-react";
import {
  RUN_LOG_REPLAY_BOUNDARY,
  type RunCardModel,
  type RunCardState,
} from "../../lib/assistant-run-adapter";

// Delegated run card (ADR-0004; herald-chat.html § run-cards,
// herald-chat-upgrades.html § delegated-run replay). Rendered as a sibling of
// the assistant bubble that spawned the run. The card is persisted (the
// `assistant_runs` row) but the step/event log is live-only — see the adapter's
// replay boundary.

const STATE_META: Record<RunCardState, { label: string; dot: string; color: string }> = {
  dispatching: { label: "Dispatching", dot: "var(--lx-text-muted)", color: "var(--lx-text-secondary)" },
  running: { label: "Running", dot: "var(--lx-text-link)", color: "var(--lx-text-link)" },
  done: { label: "Done", dot: "var(--lx-text-success)", color: "var(--lx-text-success)" },
  failed: { label: "Failed", dot: "var(--lx-text-danger)", color: "var(--lx-text-danger)" },
  stopped: { label: "Stopped", dot: "var(--lx-text-muted)", color: "var(--lx-text-secondary)" },
};

const STATE_CLASS: Record<RunCardState, string> = {
  dispatching: "state-queued",
  running: "",
  done: "state-done",
  failed: "state-failed",
  stopped: "state-stopped",
};

const ERROR_CODE = /^[A-Z][A-Z0-9_]+$/;

function stepsLabel(model: RunCardModel): string {
  if (model.state === "dispatching") return "starting…";
  const n = model.stepsUsed ?? 0;
  if (model.state === "running") return `step ${n}`;
  return `${n} steps`;
}

function autoWritesLabel(model: RunCardModel): string {
  if (model.state === "done") return `Auto — ${model.autoWrites} writes applied automatically`;
  return `Auto — ${model.autoWrites} writes applied before the stop`;
}

export interface AssistantRunCardProps {
  model: RunCardModel;
  onAbort?: ((runId: string) => void) | undefined;
  onRetry?: ((goal: string) => void) | undefined;
}

export function AssistantRunCard({ model, onAbort, onRetry }: AssistantRunCardProps) {
  const [open, setOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(true);
  const meta = STATE_META[model.state];
  const active = model.state === "dispatching" || model.state === "running";
  const terminal = model.state === "done" || model.state === "failed" || model.state === "stopped";
  const showAuto = terminal && model.live && model.autoWrites > 0;
  const failedCode = model.state === "failed" && model.error !== null && ERROR_CODE.test(model.error);

  return (
    <div className={`run-card ${STATE_CLASS[model.state]}`.trim()}>
      <div className="run-card-head">
        <span className="run-card-kind">Background run</span>
        <span className="run-card-goal" title={model.goal}>
          {model.goal}
        </span>
        <span className="run-card-state" style={{ color: meta.color }}>
          <span className="status-dot" style={{ background: meta.dot }} />
          {meta.label}
        </span>
      </div>

      <div className="run-card-progress">
        {active ? (
          <>
            <span className="run-card-bar is-indeterminate">
              <span />
            </span>
            <span className="run-card-steps">{stepsLabel(model)}</span>
          </>
        ) : (
          <span className="run-card-steps" style={{ flex: 1 }}>
            {stepsLabel(model)}
          </span>
        )}
      </div>

      {model.state === "done" && model.result && <div className="run-card-summary">{model.result}</div>}

      {model.state === "failed" && model.error && (
        <div className="notice notice-danger" style={{ marginTop: 8, alignItems: "flex-start" }}>
          <AlertCircle size={14} strokeWidth={1.5} aria-hidden="true" />
          <span style={{ display: "block" }}>
            {failedCode ? (
              <>
                <span className="font-mono" style={{ fontWeight: 500 }}>
                  {model.error}
                </span>
                <br />
                The run stopped before finishing.
              </>
            ) : (
              model.error
            )}
          </span>
        </div>
      )}

      {model.state === "stopped" && (
        <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
          <span
            className="font-micro"
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "var(--lx-text-muted)",
            }}
          >
            ● Stopped by you
          </span>
          <span style={{ flex: 1, height: 1, background: "var(--lx-border-subtle)" }} />
        </div>
      )}

      {showAuto && (
        <div className="run-card-auto">
          <span className="status-dot" style={{ background: "var(--lx-text-warning)" }} />
          {autoWritesLabel(model)}
        </div>
      )}

      <div className="run-card-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <>
              Close run
              <ChevronDown size={10} strokeWidth={1.5} />
            </>
          ) : (
            "Open run"
          )}
        </button>
        {active && onAbort && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ borderColor: "var(--lx-bg-danger-subtle)", color: "var(--lx-text-danger)" }}
            onClick={() => onAbort(model.runId)}
          >
            Stop
          </button>
        )}
        {(model.state === "failed" || model.state === "stopped") && onRetry && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onRetry(model.goal)}>
            <RefreshCw size={12} strokeWidth={1.5} />
            Retry
          </button>
        )}
      </div>

      {open && (
        <div className="run-card-detail">
          <div className="run-detail-row">
            <span className="run-detail-label">Run</span>
            <span className="font-mono" style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>
              {model.runId}
            </span>
          </div>
          {model.mode && (
            <div className="run-detail-row">
              <span className="run-detail-label">Mode</span>
              <span style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>{model.mode}</span>
            </div>
          )}
          <div className="run-detail-row">
            <span className="run-detail-label">Steps</span>
            <span className="font-mono" style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>
              {stepsLabel(model)}
            </span>
          </div>
          <div className="run-detail-row">
            <span className="run-detail-label">Events</span>
            <span style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>
              {model.live ? "live log — this tab only (not persisted)" : "persisted columns only"}
            </span>
          </div>

          {model.live ? (
            <>
              {model.events.length > 0 && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-expanded={eventsOpen}
                    style={{ alignSelf: "flex-start", marginTop: 2 }}
                    onClick={() => setEventsOpen((v) => !v)}
                  >
                    {eventsOpen ? "Hide events" : "Show events"}
                  </button>
                  {eventsOpen &&
                    model.events.map((line, i) => (
                      <div className="run-event" key={`${line.name}-${i}`}>
                        <span className="run-event-name">[{line.name}]</span>
                        <span>
                          {line.text}
                          {line.auto && <span style={{ color: "var(--lx-text-warning)" }}> · auto-write</span>}
                        </span>
                      </div>
                    ))}
                </>
              )}
              {model.events.length === 0 && (
                <div className="run-card-missing">No events yet.</div>
              )}
            </>
          ) : (
            <div className="run-card-missing">{RUN_LOG_REPLAY_BOUNDARY}</div>
          )}

          {model.result && model.state !== "done" && (
            <div className="run-detail-row" style={{ marginTop: 4 }}>
              <span className="run-detail-label">Result</span>
              <span style={{ fontSize: 12, color: "var(--lx-text-secondary)" }}>{model.result}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
