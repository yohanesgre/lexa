import { useEffect, useLayoutEffect, useRef, useState, useEffectEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Hammer, Maximize } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { cn } from "../ui/cn";
import { docToMarkdown } from "../../../shared/markdown";
import { useCreateForgeTask, useForgeTask, useRuntimes, useRecentForgeTask, useCancelForgeTask, useForgeTaskLogs, useForgeAgents, useForgeSkills } from "../../lib/queries";
import { parseApiDate } from "../../lib/date";
import { ForgeTaskLogModal } from "./ForgeTaskLogModal";
import type { ForgeAgent, ForgeSkill, Runtime } from "../../../shared/types";

// Task ids the user rejected this session — never re-attach to them on
// reopen, so a rejected result isn't offered again in this session.
const dismissedIdsRef = new Set<string>();

// More than this many agents/skills collapses the chip row into a dropdown.
const CHIP_MAX = 6;

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC — render the local
// wall-clock time for the log's timestamp column.
function formatLogTime(iso: string): string {
  const d = parseApiDate(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

interface ForgePopoverProps {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  open: boolean;
  onClose: () => void;
  onReview: (text: string, identity: { action: string; runtimeName: string | null; provider: string | null; taskId: string }) => void;
  reviewActive: boolean;
  // Task id accepted in the review banner this session — terminal state, so
  // the result is never offered for insert again (prevents duplicates).
  appliedTaskId?: string | null;
  anchorRect: DOMRect | null;
}

function PromptFields({ extraPrompt, setExtraPrompt, runtimeId, setRuntimeId, onlineRuntimes }: {
  extraPrompt: string;
  setExtraPrompt: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  onlineRuntimes: Runtime[];
}) {
  return (
    <>
      {/* Additional prompt — per-run free text, appended to the task prompt */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>
          Additional prompt <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ marginLeft: 4 }}>Optional</span>
        </span>
        <textarea
          className="prop-input w-full"
          rows={3}
          aria-label="Additional prompt"
          value={extraPrompt}
          onChange={(e) => setExtraPrompt(e.target.value)}
          placeholder="Extra instructions for this run…"
          style={{ fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
        />
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Runtime</span>
        <select
          className="prop-input w-full"
          aria-label="Runtime"
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
    </>
  );
}



const renderChips = <T,>(items: T[], selected: string | null, onSelect: (id: string) => void, label: (item: T) => string, idOf: (item: T) => string, restOpen: boolean, setRestOpen: (v: boolean) => void) => {
  const visible = items.length > CHIP_MAX ? items.slice(0, CHIP_MAX) : items;
  const rest = items.length > CHIP_MAX ? items.slice(CHIP_MAX) : [];
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
      {visible.map((item) => (
        <button
          key={idOf(item)}
          type="button"
          className="btn btn-ghost"
          style={{
            height: 26, padding: "0 10px", fontSize: 12,
            borderColor: selected === idOf(item) ? "var(--lx-border-focus)" : undefined,
            color: selected === idOf(item) ? "var(--lx-text-primary)" : undefined,
          }}
          onClick={() => onSelect(idOf(item))}
        >
          {label(item)}
        </button>
      ))}
      {rest.length > 0 && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 26, padding: "0 10px", fontSize: 12 }}
            aria-label="More options"
            onClick={() => setRestOpen(!restOpen)}
            aria-expanded={restOpen}
          >
            ⋯
          </button>
          {restOpen && (
            <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 10, padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {rest.map((item) => (
                <button
                  key={idOf(item)}
                  type="button"
                  className="menu-item"
                  style={{ fontSize: 12, color: selected === idOf(item) ? "var(--lx-text-primary)" : undefined }}
                  onClick={() => {
                    onSelect(idOf(item));
                    setRestOpen(false);
                  }}
                >
                  {label(item)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
export function ForgePopover({ editor, slug, documentType, documentId, open, onClose, onReview, reviewActive, appliedTaskId, anchorRect }: ForgePopoverProps) {
  // Agent + dependent Skill pickers: the skill list only shows skills attached
  // to the selected agent (M2M bindings managed in Settings → Agents).
  const { data: agents = [] } = useForgeAgents();
  const { data: skills = [] } = useForgeSkills();
  const [agentId, setAgentId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [extraPrompt, setExtraPrompt] = useState("");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  const logBodyRef = useRef<HTMLDivElement>(null);
  const { data: runtimes = [] } = useRuntimes();
  // Any online runtime can run tasks — Forge uses the daemon's agent CLI
  // directly (the claim carries all context), no Lexa MCP connection needed.
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const createTask = useCreateForgeTask();
  const cancelTask = useCancelForgeTask();
  const task = useForgeTask(taskId, open && taskId !== null);
  // Live "what is it doing" feed — polls while the task is queued/running.
  const logs = useForgeTaskLogs(taskId, open && taskId !== null);
  // Background resume: if a task for this doc is running/completed from a
  // previous popover session, surface it instead of losing it. Tasks the
  // user explicitly dismissed (Reject) are not re-attached.
  const recent = useRecentForgeTask(slug, documentType, documentId, open && taskId === null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Default selection derives during render: the builtin "Lexa" agent (or the
  // first agent) and its first attached skill. Changing the agent resets the
  // skill by falling back to the first attached skill of the new agent.
  const effectiveAgentId = agentId !== "" ? agentId : (agents.find((a) => a.id === "lexa")?.id ?? agents[0]?.id ?? "");
  const selectedAgent: ForgeAgent | null = agents.find((a) => a.id === effectiveAgentId) ?? null;
  const agentSkillIds = new Set(selectedAgent?.skillIds ?? []);
  const agentSkills: ForgeSkill[] = selectedAgent ? skills.filter((s) => agentSkillIds.has(s.id)) : [];
  const effectiveSkillId = agentSkillIds.has(skillId) ? skillId : (agentSkills[0]?.id ?? "");
  const selectedSkill: ForgeSkill | null = agentSkills.find((s) => s.id === effectiveSkillId) ?? null;

  // Auto-select the first online runtime.
  useEffect(() => {
    if (runtimeId === "" && onlineRuntimes.length > 0) {
      setRuntimeId(onlineRuntimes[0].id);
    }
  }, [onlineRuntimes, runtimeId]);

  const onOutsideClick = useEffectEvent((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      onClose();
    }
  });
  const onDocumentKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // The expanded log viewer owns Escape while it is open.
    if (e.key === "Escape" && !logModalOpen) onClose();
  });
  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open]);

  // When the popover reopens and there's a recent task (from a background run),
  // attach to it so the user can accept/reject the finished result. Tasks the
  // user already applied (accepted in the review banner) or explicitly
  // dismissed are skipped — the popover starts fresh for the next Forge run.
  const [prevAttachId, setPrevAttachId] = useState<string | null>(null);
  const attachId =
    open && taskId === null && recent?.data && (recent.data.status === "queued" || recent.data.status === "running" || recent.data.status === "completed") && !dismissedIdsRef.has(recent.data.id) && recent.data.id !== appliedTaskId
      ? recent.data.id
      : null;
  if (attachId !== null && prevAttachId !== attachId) {
    setPrevAttachId(attachId);
    setTaskId(attachId);
  }

  // Follow mode: keep the activity log pinned to the newest line while the
  // task runs. The user can pause it (manual scroll) via the Follow toggle.
  useEffect(() => {
    if (followLog && logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [logs.data, followLog]);

  // The popover grows with task state (running log, buttons) and the anchor
  // can sit low — or off-screen — when the editor is deep in a scrollable
  // slideover. Without clamping the picker rows can end up below the fold,
  // unreachable. Prefer anchoring below the button; flip above when it
  // doesn't fit there; as a last resort pin it inside the viewport so the
  // controls stay reachable either way. Clamp the left edge too.
  const [popoverTop, setPopoverTop] = useState(0);
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const h = containerRef.current.offsetHeight;
    const belowTop = (anchorRect?.bottom ?? 8) + 6;
    const aboveTop = (anchorRect?.top ?? 8) - h - 6;
    const fitsBelow = belowTop >= 8 && belowTop + h <= window.innerHeight - 8;
    const fitsAbove = aboveTop >= 8 && aboveTop + h <= window.innerHeight - 8;
    const top = fitsBelow
      ? belowTop
      : fitsAbove
        ? aboveTop
        : Math.max(8, Math.min(belowTop, window.innerHeight - 8 - h));
    setPopoverTop((prev) => (prev === top ? prev : top));
  });

  if (!open) return null;

  // The selection is sent to the agent as Markdown (not plain text) so the
  // model can preserve the document's formatting — headings, lists, bold,
  // code fences, task lists — and mirror it in its output.
  const selectionText = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
  const selectionMarkdown = docToMarkdown({
    type: "doc",
    content: editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to).content.toJSON(),
  } as import("../../../shared/types").TipTapDoc);

  const handleGenerate = () => {
    if (!selectedAgent || !selectedSkill) return;
    createTask.mutate(
      {
        slug,
        documentType,
        documentId,
        agentId: selectedAgent.id,
        skillId: selectedSkill.id,
        extraPrompt: extraPrompt || undefined,
        selection: selectionMarkdown || selectionText,
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
        top: popoverTop,
        left: Math.min(Math.max(8, anchorRect.left), (typeof window !== "undefined" ? window.innerWidth : 0) - 348),
        zIndex: 80,
        width: 340,
      }
    : {};

;

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;

  return createPortal(
    <div ref={containerRef} className="menu-popover" data-forge-popover style={popoverStyle}>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="text-sm font-medium text-lx-text-primary font-body">Forge</span>
        <span className={cn("font-micro text-2xs uppercase tracking-[0.04em]", running ? "text-lx-text-warning" : "text-lx-text-muted")}>
          {running ? "Running…" : "AI writing assistant"}
        </span>
      </div>

      {/* Agent picker — rule bundle, distinct from the runtime's CLI agent */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Agent</span>
        {renderChips(agents, effectiveAgentId, setAgentId, (a) => a.name, (a) => a.id, agentMenuOpen, setAgentMenuOpen)}
      </div>

      {/* Skill picker — only the selected agent's attached skills */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Skill</span>
        {selectedAgent && agentSkills.length > 0 ? (
          renderChips(agentSkills, effectiveSkillId, setSkillId, (s) => s.name, (s) => s.id, skillMenuOpen, setSkillMenuOpen)
        ) : (
          <div style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "8px 10px" }}>
            <span className="text-xs text-lx-text-muted">No skills attached — add them in Settings.</span>
          </div>
        )}
      </div>

      <PromptFields
        extraPrompt={extraPrompt}
        setExtraPrompt={setExtraPrompt}
        runtimeId={runtimeId}
        setRuntimeId={setRuntimeId}
        onlineRuntimes={onlineRuntimes}
      />


      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          {selectionText ? `Selection: ${selectionText.length} chars` : "No selection"}
        </span>
        {!taskId && (
          <button type="button" className="btn btn-primary" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={handleGenerate} disabled={createTask.isPending || onlineRuntimes.length === 0 || !selectedAgent || !selectedSkill}>
            <Hammer size={12} strokeWidth={1.5} />
            {createTask.isPending ? "Starting…" : "Generate"}
          </button>
        )}
      </div>

      {taskId && (
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
                title="Cancel this Forge task — it stops working server-side"
              >
                Cancel
              </button>
            </div>
          )}
          {running && (logs.data ?? []).length > 0 && (
            <div className="forge-task-log" style={{ marginBottom: 8 }}>
              <div className="forge-task-log-head">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span>Activity</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 18, padding: "0 5px", fontSize: 10, lineHeight: "16px" }}
                    onClick={() => setLogModalOpen(true)}
                    aria-label="Expand log"
                    title="Open the full log viewer"
                  >
                    <Maximize size={10} strokeWidth={1.5} />
                  </button>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span className="font-micro text-2xs uppercase tracking-[0.04em]" style={{ color: "var(--lx-text-muted)" }}>Follow</span>
                    <button
                      type="button"
                      className={cn("btn btn-ghost", followLog && "is-active")}
                      aria-pressed={followLog}
                      aria-label={followLog ? "Pause auto-scroll" : "Resume auto-scroll"}
                      title={followLog ? "Pause auto-scroll" : "Resume auto-scroll"}
                      style={{ height: 18, padding: "0 6px", fontSize: 10, lineHeight: "16px" }}
                      onClick={() => setFollowLog((v) => !v)}
                    >
                      ●
                    </button>
                  </span>
                  <span className="forge-task-log-live">● live</span>
                </span>
              </div>
              <div className="forge-task-log-body" ref={logBodyRef}>
                {logs.data!.slice(-50).map((line) => {
                  // stderr lines are prefixed [stderr] by the daemon — tint
                  // them danger so errors stand out from the stdout stream.
                  const isStderr = line.message.startsWith("[stderr]");
                  const isLast = line.id === logs.data![logs.data!.length - 1].id;
                  return (
                    <div key={line.id} className={cn("forge-task-log-line", isStderr && "stderr", isLast && "current")}>
                      <span className="forge-task-log-dot" aria-hidden="true">{isStderr ? "!" : "●"}</span>
                      <span className="forge-task-log-time">{formatLogTime(line.createdAt)}</span>
                      <span className="forge-task-log-msg">{line.message}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(done || failed) && (
            <>
              {failed ? (
                <div className="border rounded-md p-3 text-[13px] leading-5 font-body whitespace-pre-wrap max-h-56 overflow-y-auto text-lx-text-danger bg-lx-bg-danger-subtle border-lx-border-default">
                  {taskData?.error}
                </div>
              ) : (
                <div
                  className="border rounded-md p-3 text-[13px] leading-5 font-body"
                  style={{ background: "var(--lx-surface-input)", borderColor: "var(--lx-border-default)", color: "var(--lx-text-secondary)" }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Check size={14} strokeWidth={2.5} className="text-lx-text-success" />
                    <span className="font-medium text-lx-text-primary">{taskData?.documentTitle || "Document"}</span>
                  </div>
                  <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
                    {taskData?.skillName ? taskData.skillName : ""} — ready to review
                  </span>
                </div>
              )}
              {!failed && (
                <div className="flex items-center justify-end gap-2 mt-3">
                  {reviewActive ? (
                    <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">In review in editor</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ height: 26, padding: "0 10px", fontSize: 12 }}
                        onClick={() => {
                          if (taskData) dismissedIdsRef.add(taskData.id);
                          setTaskId(null);
                        }}
                      >
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
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ height: 26, padding: "0 10px", fontSize: 12 }}
                    onClick={() => {
                      if (taskData) dismissedIdsRef.add(taskData.id);
                      setTaskId(null);
                    }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Rendered inside the popover so the fixed modal layers above it (the
          popover's stacking context is z-80). */}
      {logModalOpen && (
<ForgeTaskLogModal
        open={logModalOpen}
        onClose={() => setLogModalOpen(false)}
        task={taskData}
        logs={logs.data ?? []}
        runtimes={runtimes}
      />
      )}
    </div>,
    portalTarget
  );
}
