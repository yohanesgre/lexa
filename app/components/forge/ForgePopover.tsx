import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Hammer } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { cn } from "../ui/cn";
import { useCreateForgeTask, useForgeTask, useRuntimes, useRecentForgeTask } from "../../lib/queries";

export type ForgeAction = "continue" | "rewrite" | "summarize" | "expand" | "grammar";

const ACTIONS: { value: ForgeAction; label: string }[] = [
  { value: "continue", label: "Continue" },
  { value: "rewrite", label: "Rewrite" },
  { value: "summarize", label: "Summarize" },
  { value: "expand", label: "Expand" },
  { value: "grammar", label: "Fix grammar" },
];

interface ForgePopoverProps {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  open: boolean;
  onClose: () => void;
  onAccept: (text: string) => void;
  anchorRect: DOMRect | null;
}

export function ForgePopover({ editor, slug, documentType, documentId, open, onClose, onAccept, anchorRect }: ForgePopoverProps) {
  const [action, setAction] = useState<ForgeAction>("continue");
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const { data: runtimes = [] } = useRuntimes();
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const createTask = useCreateForgeTask();
  const task = useForgeTask(taskId, open && taskId !== null);
  // Background resume: if a task for this doc is running/completed from a
  // previous popover session, surface it instead of losing it.
  const recent = useRecentForgeTask(slug, documentType, documentId, open && taskId === null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-select the first online runtime.
  useEffect(() => {
    if (runtimeId === "" && onlineRuntimes.length > 0) {
      setRuntimeId(onlineRuntimes[0].id);
    }
  }, [onlineRuntimes, runtimeId]);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setTaskId(null);
      setAction("continue");
    }
  }, [open]);

  // When the popover reopens and there's a recent task (from a background run),
  // attach to it so the user can accept/reject the finished result.
  useEffect(() => {
    if (open && taskId === null && recent?.data && (recent.data.status === "queued" || recent.data.status === "running" || recent.data.status === "completed")) {
      setTaskId(recent.data.id);
    }
  }, [open, recent, taskId]);

  if (!open) return null;

  const selectionText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");

  const handleGenerate = () => {
    createTask.mutate(
      {
        slug,
        documentType,
        documentId,
        action,
        selection: selectionText,
        runtimeId: runtimeId || undefined,
      },
      { onSuccess: (t) => setTaskId(t.id) }
    );
  };

  const taskData = task.data ?? null;
  const running = taskData?.status === "queued" || taskData?.status === "running";
  const done = taskData?.status === "completed";
  const failed = taskData?.status === "failed";

  const popoverStyle: React.CSSProperties = anchorRect
    ? {
        position: "fixed",
        top: anchorRect.bottom + 6,
        left: Math.min(anchorRect.left, window.innerWidth - 360),
        zIndex: 80,
        width: 340,
      }
    : {};

  return createPortal(
    <div ref={containerRef} className="menu-popover" style={popoverStyle}>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="text-sm font-medium text-lx-text-primary font-body">Forge</span>
        <span className={cn("font-micro text-2xs uppercase tracking-[0.04em]", running ? "text-lx-text-warning" : "text-lx-text-muted")}>
          {running ? "Running…" : "AI writing assistant"}
        </span>
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Action</span>
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          {ACTIONS.map((a) => (
            <button
              key={a.value}
              type="button"
              className="btn btn-ghost"
              style={{
                height: 26, padding: "0 10px", fontSize: 12,
                borderColor: action === a.value ? "var(--lx-border-focus)" : undefined,
                color: action === a.value ? "var(--lx-text-primary)" : undefined,
              }}
              onClick={() => setAction(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Runtime</span>
        <select
          className="prop-input w-full"
          value={runtimeId}
          onChange={(e) => setRuntimeId(e.target.value)}
          style={{ height: 28, fontSize: 12 }}
          disabled={onlineRuntimes.length === 0}
        >
          {onlineRuntimes.length === 0 ? (
            <option value="">No runtime online</option>
          ) : (
            onlineRuntimes.map((r) => (
              <option key={r.id} value={r.id}>{r.name} · {r.provider}</option>
            ))
          )}
        </select>
      </div>

      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          {selectionText ? `Selection: ${selectionText.length} chars` : "No selection"}
        </span>
        {!taskId && (
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={handleGenerate} disabled={createTask.isPending || onlineRuntimes.length === 0}>
            <Hammer size={12} strokeWidth={1.5} />
            {createTask.isPending ? "Starting…" : "Generate"}
          </button>
        )}
      </div>

      {taskId && (
        <div style={{ padding: "0 12px 12px" }}>
          {running && (
            <div className="flex items-center gap-2 mb-2">
              <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              <span className="text-xs text-lx-text-secondary font-body">
                {taskData?.runtimeId ? "Agent working… (closing this popup won't cancel it)" : "Queued…"}
              </span>
            </div>
          )}
          {(done || failed) && (
            <>
              <div
                className={cn(
                  "border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto",
                  failed ? "text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default" : "text-lx-text-secondary bg-lx-surface-input border-lx-border-default"
                )}
              >
                {failed ? taskData?.error : taskData?.result}
              </div>
              <div className="flex items-center justify-end gap-2 mt-3">
                <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={() => setTaskId(null)}>
                  Reject
                </button>
                {done && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ height: 26, padding: "0 10px", fontSize: 12 }}
                    onClick={() => {
                      if (taskData?.result) onAccept(taskData.result);
                      setTaskId(null);
                      onClose();
                    }}
                  >
                    <Check size={12} strokeWidth={2.5} />
                    Accept
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>,
    document.body
  );
}
