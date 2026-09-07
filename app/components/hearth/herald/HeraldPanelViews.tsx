import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Check, RefreshCw, Square } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { HeraldSettingsMasked } from "../../../../shared/herald";
import { HeraldToolChips } from "./HeraldToolChips";
import { EngineToggle } from "./HeraldModePicker";
import type { HearthMode } from "./HeraldModePicker";
import { insertMarkdown } from "./herald-panel-utils";
import type { useHeraldStream } from "../../../lib/use-herald-stream";

type Stream = ReturnType<typeof useHeraldStream>;
type ReviewIdentity = { action: string; runtimeName: string | null; provider: string | null; taskId: string };

// Herald tier panel chrome (herald-popover.html header): flame glyph +
// phase-aware right slot. Shared flame icon for the popover shell.
export function HearthFlameIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

export function HeraldPanelHeader({
  running,
  done,
  failed,
  engineSwitcherEnabled,
  onModeChange,
}: {
  running: boolean;
  done: boolean;
  failed: boolean;
  engineSwitcherEnabled: boolean;
  onModeChange: (mode: HearthMode) => void;
}) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
      <span className="text-sm font-medium text-lx-text-primary font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <HearthFlameIcon />
        Hearth
      </span>
      <HeaderStatus
        running={running}
        done={done}
        failed={failed}
        engineSwitcherEnabled={engineSwitcherEnabled}
        onModeChange={onModeChange}
      />
    </div>
  );
}

function HeaderStatus({ running, done, failed, engineSwitcherEnabled, onModeChange }: {
  running: boolean;
  done: boolean;
  failed: boolean;
  engineSwitcherEnabled: boolean;
  onModeChange: (mode: HearthMode) => void;
}) {
  if (running) {
    return <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Generating…</span>;
  }
  if (done) {
    return <span className="font-micro text-2xs text-lx-text-success uppercase tracking-[0.04em]">Ready</span>;
  }
  if (failed) {
    return <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">Failed</span>;
  }
  // Member engine toggle renders ONLY when the project enables the switcher;
  // picking Blacksmith hands the popover back to the parent shell.
  if (engineSwitcherEnabled) {
    return <EngineToggle enabled mode="herald" onChange={onModeChange} />;
  }
  return <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Herald · AI project assistant</span>;
}

function ProviderMissing({ projectId }: { projectId: string | undefined }) {
  return (
    <>
      <div className="empty-state" style={{ padding: "32px 20px" }}>
        <div className="empty-state-icon">
          <HearthFlameIcon size={24} />
        </div>
        <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
        <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 240 }}>
          Herald runs against a per-project provider endpoint. Set one up in Project Settings → Herald provider.
        </p>
        {projectId && (
          <Link
            to="/settings/project/$projectId"
            params={{ projectId }}
            className="btn btn-primary btn-sm mt-3"
            style={{ textDecoration: "none" }}
          >
            Open Settings
          </Link>
        )}
      </div>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
        <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">PROVIDER_NOT_CONFIGURED · 409</span>
        <button type="button" className="btn btn-primary btn-sm" disabled style={{ opacity: 0.45 }}>Generate</button>
      </div>
    </>
  );
}

function monoBox(maxHeight: number): React.CSSProperties {
  return {
    background: "var(--lx-surface-input)",
    border: "1px solid var(--lx-border-default)",
    borderRadius: 6,
    padding: "10px 12px",
    fontFamily: "var(--lx-font-mono)",
    fontSize: 11,
    lineHeight: "18px",
    color: "var(--lx-text-secondary)",
    maxHeight,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  };
}

function providerLine(settings: HeraldSettingsMasked | null | undefined): string {
  let host = "";
  try {
    if (settings?.baseUrl) host = `${new URL(settings.baseUrl).host} · `;
  } catch {
    host = "";
  }
  return `${host}herald · ${settings?.kind ?? ""}`;
}

// Live preview: raw markdown deltas appended verbatim into the mono box —
// never rendered rich mid-stream. Auto-scroll pins to the newest line while
// the user hasn't scrolled up; any manual scroll-up pauses follow until
// scrolled back to the bottom.
function StreamingPreview({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div style={{ padding: "10px 12px" }}>
      <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
        Preview <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>raw markdown</span>
      </span>
      <div
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        style={monoBox(180)}
      >
        {text}
        <span style={{ animation: "lx-wip-pulse 1.2s ease-in-out infinite", color: "var(--lx-border-focus)" }}>▍</span>
      </div>
    </div>
  );
}

export function HeraldPanelBody({
  stream,
  settings,
  providerMissing,
  projectId,
  documentTitle,
  skillName,
  provider,
  taskId,
  appliedTaskId,
  rejectedTaskId,
  reviewActive,
  onReview,
  onRetry,
  onStop,
  onDismiss,
  editor,
  onClose,
  children,
}: {
  stream: Stream;
  settings: HeraldSettingsMasked | null | undefined;
  providerMissing: boolean;
  projectId: string | undefined;
  documentTitle: string | undefined;
  skillName: string;
  provider: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: (text: string, identity: ReviewIdentity) => void;
  onRetry: () => void;
  onStop: () => void;
  onDismiss: () => void;
  onClose: () => void;
  editor: Editor;
  children: React.ReactNode;
}) {
  if (providerMissing) {
    return <ProviderMissing projectId={projectId} />;
  }

  const running = stream.status === "connecting" || stream.status === "streaming";
  const done = stream.status === "done";
  const failed = stream.status === "error";

  if (running) {
    return (
      <>
        <div style={{ padding: "10px 12px 0" }}>
          <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Tools</span>
          <HeraldToolChips tools={stream.tools} />
        </div>
        <StreamingPreview text={stream.text} />
        <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{providerLine(settings)}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ borderColor: "rgba(255,68,68,0.45)", color: "var(--lx-text-danger)" }}
            onClick={onStop}
          >
            <Square size={12} strokeWidth={1.5} fill="currentColor" />
            Stop
          </button>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <DoneView
        stream={stream}
        documentTitle={documentTitle}
        skillName={skillName}
        provider={provider}
        taskId={taskId}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
        reviewActive={reviewActive}
        onReview={onReview}
        onDismiss={onDismiss}
        editor={editor}
        onClose={onClose}
      />
    );
  }

  if (failed) {
    return (
      <div style={{ padding: 12 }}>
        <div className="notice notice-danger" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <div className="flex items-center gap-2">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <span className="font-mono text-xs font-medium">{stream.error?.code}</span>
          </div>
          <span className="text-xs" style={{ lineHeight: "16px" }}>{stream.error?.message}</span>
        </div>
        {/* Retry re-enqueues with the same prompt/agent/skill and returns
            the panel to streaming; Dismiss clears back to idle — the
            thread keeps prior turns. */}
        <div className="flex items-center justify-end gap-2 mt-3">
          <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onDismiss}>Dismiss</button>
          <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onRetry}>
            <RefreshCw size={12} strokeWidth={1.5} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function DoneView({
  stream,
  documentTitle,
  skillName,
  provider,
  taskId,
  appliedTaskId,
  rejectedTaskId,
  reviewActive,
  onReview,
  onDismiss,
  editor,
  onClose,
}: {
  stream: Stream;
  documentTitle: string | undefined;
  skillName: string;
  provider: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: ((text: string, identity: ReviewIdentity) => void) | undefined;
  onDismiss: () => void;
  editor: Editor;
  onClose: () => void;
}) {
  if (!taskId) return null;

  const alreadyHandled = appliedTaskId === taskId || rejectedTaskId === taskId;
  const resolvedSkillName = skillName || "Herald";

  const handleInsert = () => {
    if (!stream.text) return;
    insertMarkdown(editor, stream.text);
    onClose();
  };

  const handleReviewInEditor = () => {
    if (!stream.text) return;
    if (onReview) {
      onReview(stream.text, {
        action: resolvedSkillName,
        runtimeName: null,
        provider,
        taskId,
      });
      onClose();
    } else {
      handleInsert();
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div
        style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}
      >
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <Check size={14} strokeWidth={2.5} className="text-lx-text-success shrink-0" />
          <span className="text-xs font-medium text-lx-text-primary truncate flex-1 min-w-0" style={{ fontFamily: "var(--lx-font-body)" }}>{documentTitle || "Document"}</span>
        </div>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ letterSpacing: "0.04em" }}>
          {resolvedSkillName} — ready to review
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        {reviewActive || alreadyHandled ? (
          <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">In review in editor</span>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onDismiss}>Reject</button>
            <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleReviewInEditor}>
              <Check size={12} strokeWidth={2.5} />
              Review in editor
            </button>
          </>
        )}
      </div>
    </div>
  );
}
