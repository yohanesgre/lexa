import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { docToMarkdown } from "../../../shared/markdown";
import { useCreateHearthTask, useHearthTask, useRuntimes, useRecentHearthTask, useCancelHearthTask, useHearthTaskLogs, useAgents, useSkills, useProjects, useHeraldSettings, useSession } from "../../lib/queries";
import { useHearthSession, useResetHearthSession } from "../../lib/use-hearth-session";import { saveEngineOverlay, resolveActiveEngine, ENGINE_AGENT_IDS } from "../../lib/use-hearth-engine";
import { HearthTaskLogModal } from "./HearthTaskLogModal";
import { TaskStatusPanel } from "./HearthTaskStatusPanel";
import { BlacksmithForm } from "./HearthBlacksmithForm";
import { EngineToggle } from "./herald/HeraldModePicker";
import type { HearthMode } from "./herald/HeraldModePicker";
import { HeraldPanel } from "./herald/HeraldPanel";
import { HeraldFlameIcon } from "./herald/HeraldFlameIcon";
import type { LexaSkill, HearthTask, HearthTaskLog, Runtime } from "../../../shared/types";

// The active engine is the admin-written project default; a member's
// personal overlay (localStorage hearth-engine-overlay:<projectId>) wins
// only when the project enabled the switcher. It never writes settings.
function changeModeFor(projectId: string | undefined, next: HearthMode): HearthMode {
  if (projectId) saveEngineOverlay(projectId, next);
  return next;
}

// Task ids the user rejected this session — never re-attach to them on
// reopen, so a rejected result isn't offered again in this session.
const dismissedIdsRef = new Set<string>();

interface HearthPopoverProps {
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
  appliedTaskId?: string | null | undefined;
  // Task id rejected in the editor review surface this session — terminal
  // state, so the result isn't re-offered when the popover reopens.
  rejectedTaskId?: string | null | undefined;
  anchorRect: DOMRect | null;
}

type RecentTask = { kind: string; status: string; id: string } | null | undefined;

// Background resume: attach to a recent queued/running/completed task unless
// the user applied, rejected, or explicitly dismissed it this session.
function resolveAttachId(open: boolean, taskId: string | null, recent: RecentTask, appliedTaskId: string | null | undefined, rejectedTaskId: string | null | undefined): string | null {
  if (!open || taskId !== null || !recent || recent.kind !== "blacksmith") return null;
  if (recent.status !== "queued" && recent.status !== "running" && recent.status !== "completed") return null;
  if (dismissedIdsRef.has(recent.id) || recent.id === appliedTaskId || recent.id === rejectedTaskId) return null;
  return recent.id;
}

// Skill state for the active engine agent: junction rows only, with the
// empty selection falling back to the first attached skill.
function resolveSkillState(agents: { id: string; skillIds: string[] }[], skills: LexaSkill[], mode: HearthMode, skillId: string) {
  const activeSkillIds = new Set(agents.find((a) => a.id === ENGINE_AGENT_IDS[mode])?.skillIds ?? []);
  const agentSkills = skills.filter((s) => activeSkillIds.has(s.id));
  const effectiveSkillId = activeSkillIds.has(skillId) ? skillId : (agentSkills[0]?.id ?? "");
  const selectedSkill = agentSkills.find((s) => s.id === effectiveSkillId) ?? null;
  return { agentSkills, effectiveSkillId, selectedSkill };
}

// The selection is sent to the agent as Markdown (not plain text) so the
// model can preserve the document's formatting — headings, lists, bold,
// code fences, task lists — and mirror it in its output.
function selectionPayload(editor: Editor): { text: string; markdown: string } {
  const text = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "\n");
  const markdown = docToMarkdown({
    type: "doc",
    content: editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to).content.toJSON(),
  } as import("../../../shared/types").TipTapDoc);
  return { text, markdown };
}

// Polish can run without a selection: fall back to the whole document as
// Markdown, then plain text.
function effectiveSelectionFor(editor: Editor, skillId: string, markdown: string, text: string): string {
  let effectiveSelection = markdown || text;
  if (skillId === "polish" && !effectiveSelection.trim()) {
    try {
      const full = docToMarkdown(editor.state.doc.toJSON() as import("../../../shared/types").TipTapDoc);
      if (full.trim()) effectiveSelection = full;
      else if (editor.state.doc.textContent.trim()) effectiveSelection = editor.state.doc.textContent;
    } catch {
      if (editor.state.doc.textContent.trim()) effectiveSelection = editor.state.doc.textContent;
    }
  }
  return effectiveSelection;
}

// Prefer anchoring below the button; flip above when it doesn't fit there;
// as a last resort pin it inside the viewport so the controls stay reachable
// either way.
function computePopoverTop(anchorRect: DOMRect | null, height: number): number {
  const belowTop = (anchorRect?.bottom ?? 8) + 6;
  const aboveTop = (anchorRect?.top ?? 8) - height - 6;
  const fitsBelow = belowTop >= 8 && belowTop + height <= window.innerHeight - 8;
  const fitsAbove = aboveTop >= 8 && aboveTop + height <= window.innerHeight - 8;
  if (fitsBelow) return belowTop;
  if (fitsAbove) return aboveTop;
  return Math.max(8, Math.min(belowTop, window.innerHeight - 8 - height));
}

function computePopoverStyle(anchorRect: DOMRect | null, popoverTop: number): React.CSSProperties {
  if (!anchorRect) return {};
  return {
    position: "fixed",
    top: popoverTop,
    left: Math.min(Math.max(8, anchorRect.left), (typeof window !== "undefined" ? window.innerWidth : 0) - 348),
    zIndex: 80,
    width: 340,
  };
}

function HeaderRight({ done, failed, running, switcherEnabled, mode, changeMode, taskRunning }: {
  done: boolean; failed: boolean; running: boolean; switcherEnabled: boolean; mode: HearthMode; changeMode: (next: HearthMode) => void; taskRunning: boolean;
}) {
  if (done) return <span className="font-micro text-2xs text-lx-text-success uppercase tracking-[0.04em]">Ready</span>;
  if (failed) return <span className="font-micro text-2xs text-lx-text-danger uppercase tracking-[0.04em]">Failed</span>;
  if (running) return <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">Running…</span>;
  if (switcherEnabled) return <EngineToggle enabled mode={mode} onChange={changeMode} disabled={taskRunning} />;
  return <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">AI project assistant</span>;
}

// Document-level outside click + Escape dismiss for the open popover.
function useOutsideDismiss(open: boolean, onClose: () => void, containerRef: React.RefObject<HTMLDivElement | null>, escapeBlocked: boolean) {
  const onOutsideClick = useEffectEvent((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      onClose();
    }
  });
  const onDocumentKeyDown = useEffectEvent((e: KeyboardEvent) => {
    // The expanded log viewer owns Escape while it is open.
    if (e.key === "Escape" && !escapeBlocked) onClose();
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
}

// When the popover reopens and there's a recent task (from a background run),
// attach to it so the user can accept/reject the finished result. Tasks the
// user already applied (accepted in the review banner), rejected in the
// editor review, or explicitly dismissed are skipped — the popover starts
// fresh for the next Hearth run.
function useAttachRecentTask(open: boolean, taskId: string | null, recent: RecentTask, appliedTaskId: string | null | undefined, rejectedTaskId: string | null | undefined, setTaskId: (v: string | null) => void) {
  const [prevAttachId, setPrevAttachId] = useState<string | null>(null);
  const attachId = resolveAttachId(open, taskId, recent, appliedTaskId, rejectedTaskId);
  if (attachId !== null && prevAttachId !== attachId) {
    setPrevAttachId(attachId);
    setTaskId(attachId);
  }
}

// The popover grows with task state (running log, buttons) and the anchor
// can sit low — or off-screen — when the editor is deep in a scrollable
// slideover. Without clamping the picker rows can end up below the fold,
// unreachable. Clamp the left edge too.
function usePopoverPosition(open: boolean, anchorRect: DOMRect | null, containerRef: React.RefObject<HTMLDivElement | null>) {
  const [popoverTop, setPopoverTop] = useState(0);
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const top = computePopoverTop(anchorRect, containerRef.current.offsetHeight);
    setPopoverTop((prev) => (prev === top ? prev : top));
  });
  return popoverTop;
}

function isTaskActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

function taskPhase(status: string | null | undefined) {
  return { running: isTaskActive(status), done: status === "completed", failed: status === "failed" };
}

function buildCreateTaskInput(slug: string, documentType: "task" | "wiki", documentId: string, mode: HearthMode, skillId: string, extraPrompt: string, selection: string, runtimeId: string) {
  return {
    slug,
    documentType,
    documentId,
    agentId: ENGINE_AGENT_IDS[mode],
    skillId,
    extraPrompt: extraPrompt || undefined,
    selection,
    runtimeId: runtimeId || undefined,
  };
}

// Herald tier — full panel per herald-popover.html (own header states).
// Done state delegates to the editor review surface (diff only editor,
// never raw in popover — hearth-review.html:153).
function HeraldPortalView({ containerRef, popoverStyle, editor, slug, documentType, documentId, switcherEnabled, changeMode, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId, portalTarget }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  popoverStyle: React.CSSProperties;
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  switcherEnabled: boolean;
  changeMode: (next: HearthMode) => void;
  onClose: () => void;
  onReview: (text: string, identity: { action: string; runtimeName: string | null; provider: string | null; taskId: string }) => void;
  reviewActive: boolean;
  appliedTaskId: string | null | undefined;
  rejectedTaskId: string | null | undefined;
  portalTarget: HTMLElement;
}) {
  return createPortal(
    <div ref={containerRef} className="menu-popover" data-hearth-popover style={popoverStyle}>
      <HeraldPanel
        editor={editor}
        slug={slug}
        documentType={documentType}
        documentId={documentId}
        engineSwitcherEnabled={switcherEnabled}
        onModeChange={changeMode}
        onClose={onClose}
        onReview={onReview}
        reviewActive={reviewActive}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
      />
    </div>,
    portalTarget
  );
}

function PopoverBody({ taskId, taskData, running, failed, done, reviewActive, followLog, setFollowLog, logBodyRef, logs, isAdmin, setLogModalOpen, cancelTask, setTaskId, runtimes, onReview, agentSkills, effectiveSkillId, setSkillId, extraPrompt, setExtraPrompt, runtimeId, setRuntimeId, onlineRuntimes, sessionRow, resetSession, documentType, documentId, taskRunning, selectionText, onGenerate, creating, logModalOpen }: {
  taskId: string | null;
  taskData: HearthTask | null;
  running: boolean;
  failed: boolean;
  done: boolean;
  reviewActive: boolean;
  followLog: boolean;
  setFollowLog: (updater: (prev: boolean) => boolean) => void;
  logBodyRef: React.RefObject<HTMLDivElement | null>;
  logs: { data?: HearthTaskLog[] | undefined };
  isAdmin: boolean;
  setLogModalOpen: (v: boolean) => void;
  cancelTask: { mutate: (id: string) => void; isPending: boolean };
  setTaskId: (v: string | null) => void;
  runtimes: Runtime[];
  onReview: (text: string, identity: { action: string; runtimeName: string | null; provider: string | null; taskId: string }) => void;
  agentSkills: LexaSkill[];
  effectiveSkillId: string;
  setSkillId: (v: string) => void;
  extraPrompt: string;
  setExtraPrompt: (v: string) => void;
  runtimeId: string;
  setRuntimeId: (v: string) => void;
  onlineRuntimes: Runtime[];
  sessionRow: { updatedAt: string } | null;
  resetSession: { mutate: (input: { documentType: "task" | "wiki"; documentId: string; runtimeId: string }) => void; isPending: boolean };
  documentType: "task" | "wiki";
  documentId: string;
  taskRunning: boolean;
  selectionText: string;
  onGenerate: () => void;
  creating: boolean;
  logModalOpen: boolean;
}) {
  return (
    <>
      {taskId ? (
        <TaskStatusPanel
          taskId={taskId}
          taskData={taskData}
          running={running}
          failed={failed}
          done={done}
          reviewActive={reviewActive}
          followLog={followLog}
          setFollowLog={setFollowLog}
          logBodyRef={logBodyRef}
          logs={logs}
          canViewLogs={isAdmin}
          setLogModalOpen={setLogModalOpen}
          dismissedIdsRef={dismissedIdsRef}
          cancelTask={cancelTask}
          setTaskId={setTaskId}
          runtimes={runtimes}
          onReview={onReview}
        />
      ) : (
        <BlacksmithForm
          agentSkills={agentSkills}
          effectiveSkillId={effectiveSkillId}
          setSkillId={setSkillId}
          extraPrompt={extraPrompt}
          setExtraPrompt={setExtraPrompt}
          runtimeId={runtimeId}
          setRuntimeId={setRuntimeId}
          onlineRuntimes={onlineRuntimes}
          sessionRow={sessionRow}
          resetSession={resetSession}
          documentType={documentType}
          documentId={documentId}
          taskRunning={taskRunning}
          selectionText={selectionText}
          onGenerate={onGenerate}
          creating={creating}
        />
      )}

      {/* Rendered inside the popover so the fixed modal layers above it (the
          popover's stacking context is z-80). */}
      {logModalOpen && (
<HearthTaskLogModal
        open={logModalOpen}
        onClose={() => setLogModalOpen(false)}
        task={taskData}
        logs={logs.data ?? []}
        runtimes={runtimes}
      />
      )}
    </>
  );
}

export function HearthPopover({ editor, slug, documentType, documentId, open, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId, anchorRect }: HearthPopoverProps) {
  const { data: projects = [] } = useProjects();
  const projectId = projects.find((p) => p.slug === slug)?.id;
  // null after load = PROVIDER_NOT_CONFIGURED — the herald lane swaps in its
  // empty state; the blacksmith lane is unaffected.
  const { data: settings } = useHeraldSettings(projectId);
  const switcherEnabled = settings?.engineSwitcherEnabled === true;

  // Active engine = project default, overridden by the member's personal
  // overlay (only when the project shows the switcher). The override lives
  // in localStorage and NEVER touches herald_settings.engine.
  const [modeOverride, setModeOverride] = useState<HearthMode | null>(null);
  const mode: HearthMode = modeOverride ?? resolveActiveEngine(settings, projectId);
  const changeMode = (next: HearthMode) => {
    setModeOverride(changeModeFor(projectId, next));
    // Switching engines resets the skill to the first attached of the new
    // engine agent (hearth-popover.html annotations).
    setSkillId("");
  };

  // Skills are filtered to the ACTIVE ENGINE agent's junction list
  // (lexa_agent_skills) — no agent picker exists; the persona resolves
  // server-side from the engine.
  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  const [skillId, setSkillId] = useState("");
  const [extraPrompt, setExtraPrompt] = useState("");
  const [runtimeId, setRuntimeId] = useState<string>("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [followLog, setFollowLog] = useState(true);
  // Hydration-safe portal target: SSR and the first client render both see
  // null, the browser switches to document.body after hydration.
  const portalTarget = useSyncExternalStore(
    () => () => {},
    () => document.body,
    () => null,
  );
  const logBodyRef = useRef<HTMLDivElement>(null);
  const { data: runtimes = [] } = useRuntimes();
  // Any online runtime can run tasks — Hearth uses the daemon's agent CLI
  // directly; the claim carries all context. Empty picker + disabled
  // Generate IS the NO_RUNTIME_ONLINE surface for the blacksmith engine.
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");
  const createTask = useCreateHearthTask();
  const cancelTask = useCancelHearthTask();
  // Warm-session mapping for this document: which opencode serve conversation
  // the next Generate would continue, per runtime. Refetched on open so a
  // background run that minted a session is reflected.
  const sessions = useHearthSession(documentType, documentId, open && mode === "blacksmith");
  const resetSession = useResetHearthSession();
  const attached = open && taskId !== null;
  const task = useHearthTask(taskId, attached);
  // Live "what is it doing" feed — polls while the task is queued/running.
  // ADMIN-GATED: members don't fetch log internals (403 server-side).
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "superadmin";
  const logs = useHearthTaskLogs(taskId, attached && isAdmin);
  // Background resume: if a task for this doc is running/completed from a
  // previous popover session, surface it instead of losing it. Tasks the
  // user explicitly dismissed (Reject) are not re-attached.
  const recent = useRecentHearthTask(slug, documentType, documentId, open && taskId === null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { agentSkills, effectiveSkillId, selectedSkill } = resolveSkillState(agents, skills, mode, skillId);

  useOutsideDismiss(open, onClose, containerRef, logModalOpen);

  useAttachRecentTask(open, taskId, recent.data as RecentTask, appliedTaskId, rejectedTaskId, setTaskId);

  const popoverTop = usePopoverPosition(open, anchorRect, containerRef);

  if (!open) return null;

  const selection = selectionPayload(editor);

  const handleGenerate = () => {
    if (!selectedSkill) return;
    const effectiveSelection = effectiveSelectionFor(editor, selectedSkill.id, selection.markdown, selection.text);
    createTask.mutate(
      buildCreateTaskInput(slug, documentType, documentId, mode, selectedSkill.id, extraPrompt, effectiveSelection, runtimeId),
      { onSuccess: (t) => setTaskId(t.id) }
    );
  };

  const { running, done, failed } = taskPhase(task.data?.status);
  const taskData = task.data ?? null;

  // Session mapping for the selected runtime — the next Generate continues it
  // ("New session" when none). Reset is disabled while any task for this
  // document is running (the endpoint 409s in that case).
  const sessionRow = sessions.data?.find((s) => s.runtimeId === runtimeId);
  const taskRunning = running || isTaskActive(recent.data?.status);
  const popoverStyle = computePopoverStyle(anchorRect, popoverTop);

  if (!portalTarget) return null;

  // Herald tier — full panel per herald-popover.html (own header states).
  // Done state delegates to the editor review surface (diff only editor,
  // never raw in popover — hearth-review.html:153).
  if (mode === "herald") {
    return (
      <HeraldPortalView
        containerRef={containerRef}
        popoverStyle={popoverStyle}
        editor={editor}
        slug={slug}
        documentType={documentType}
        documentId={documentId}
        switcherEnabled={switcherEnabled}
        changeMode={changeMode}
        onClose={onClose}
        onReview={onReview}
        reviewActive={reviewActive}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
        portalTarget={portalTarget}
      />
    );
  }

  return createPortal(
    <div ref={containerRef} className="menu-popover" data-hearth-popover style={popoverStyle}>
      <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--lx-border-default)" }}>
        <span className="text-sm font-medium text-lx-text-primary font-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <HeraldFlameIcon />
          Hearth
        </span>
        <HeaderRight done={done} failed={failed} running={running} switcherEnabled={switcherEnabled} mode={mode} changeMode={changeMode} taskRunning={taskRunning} />
      </div>

      <PopoverBody
        taskId={taskId}
        taskData={taskData}
        running={running}
        failed={failed}
        done={done}
        reviewActive={reviewActive}
        followLog={followLog}
        setFollowLog={setFollowLog}
        logBodyRef={logBodyRef}
        logs={logs}
        isAdmin={isAdmin}
        setLogModalOpen={setLogModalOpen}
        cancelTask={cancelTask}
        setTaskId={setTaskId}
        runtimes={runtimes}
        onReview={onReview}
        agentSkills={agentSkills}
        effectiveSkillId={effectiveSkillId}
        setSkillId={setSkillId}
        extraPrompt={extraPrompt}
        setExtraPrompt={setExtraPrompt}
        runtimeId={runtimeId}
        setRuntimeId={setRuntimeId}
        onlineRuntimes={onlineRuntimes}
        sessionRow={sessionRow ?? null}
        resetSession={resetSession}
        documentType={documentType}
        documentId={documentId}
        taskRunning={taskRunning}
        selectionText={selection.text}
        onGenerate={handleGenerate}
        creating={createTask.isPending}
        logModalOpen={logModalOpen}
      />
    </div>,
    portalTarget
  );
}
