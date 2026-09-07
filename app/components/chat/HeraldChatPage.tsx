import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import * as api from "../../lib/api";
import {
  useProjects,
  useAgents,
  useSkills,
  useHeraldSettings,
  useHeraldChatList,
  useRenameHeraldChat,
  useDeleteHeraldChat,
  useUpdateHeraldChatMeta,
} from "../../lib/queries";
import { ENGINE_AGENT_IDS, hasVisionCapability } from "../../lib/use-hearth-engine";
import { useToast } from "../ui/Toast";
import { heraldSendForKey, useHeraldStream } from "../../lib/use-herald-stream";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { resendIndex } from "../../lib/resendIndex";
import { isNarrowViewport, hasMatchMedia, matchMedia } from "../../lib/viewport";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { ThreadsSidebar } from "./ThreadsSidebar";
import { SkillPicker } from "../hearth/herald/SkillPicker";
import { HeraldFlameIcon } from "../hearth/herald/HeraldFlameIcon";
import { HeraldActivity } from "./HeraldActivity";
import { deriveChatTitle, type HeraldReasoningEffort } from "../../../shared/herald";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { hhmm } from "./herald-chat-utils";
import { settleTurns } from "./herald-chat-turns-state";
import { useChatSidebar, useChatAutoScroll, useSkillsPanelDefault } from "./herald-chat-hooks";
import {
  chatPageFlags,
  chatSkillsOf,
  lastUserIndex,
  streamDoneActivity,
  suspendTallyText,
  truncateTurns,
  appendEphemeralUserTurn,
  orphanThreadNeedsRecovery,
  recoverStaleThread,
  staleThreadNeedsRecovery,
} from "./herald-chat-logic";
import {
  useApprovalDecisions,
  useChatStartStream,
  useSettledTurns,
  useStreamFrameFreeze,
  useTerminalRefetch,
  useThreadListIngress,
  useTurnResend,
  useChatThreadActions,
  useChatEditing,
  useChatProjectQueries,
  useThreadKnowledge,
} from "./herald-chat-session";
import type { ActivityView, ChatTurn } from "./herald-chat-utils";
import { HeraldChatComposer } from "./HeraldChatComposer";
import { HeraldAssistantBubble } from "./HeraldAssistantBubble";
import { HeraldApprovalBatch, type ApprovalChip } from "./HeraldApprovals";
import { ChatProviderMissingPanel } from "./HeraldChatTurns";
import { ChatComposerArea, ChatHeader, ChatTranscriptArea } from "./HeraldChatShell";

// Herald Chat — dedicated /$slug/chat route (herald-chat.html +
// herald-chat-upgrades.html). Multi-thread per (project, user): the History
// dropdown lists threads (?thread= deep link), each thread keeps a client
// uuid in document_id; "last visited" persists in localStorage
// lexa-chat-last:<projectId>. No queue row — streams are direct SSE.
// No agent picker: the persona mirrors the project's configured Herald Agent
// (read-only); only the optional skill is picked per message. Transcript
// affordances (hover copy/edit/regenerate, citation chips,
// failed/interrupted treatments) transcribe herald-chat-upgrades.html.



export function HeraldChatPage({ slug, thread }: { slug: string; thread?: string | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug/chat" });
  const fallbackTo = useCallback(
    (fallbackSlug: string, threadId: string | undefined) =>
      void navigate({
        to: "/$slug/chat",
        params: { slug: fallbackSlug },
        search: threadId ? { thread: threadId } : {},
        replace: true,
      }),
    [navigate]
  );
  const { projects, projectFromList, projectError, project, resolved, projectId, settings, settingsLoading } =
    useChatProjectQueries({ slug });
  // Sidebar visibility — the collapse control lives INSIDE the sidebar
  // (herald-chat.html, mirroring the wiki sidebar); persists in localStorage
  // lexa-chat-sidebar.
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useChatSidebar();

  // Invalid slug (deleted project / stale bookmark): fall back to the first
  // available workspace project instead of rendering a dead shell. Waits for
  // resolution to settle (list miss + detail query error) before redirecting;
  // ?thread= rides along.
  useEffect(() => {
    if (resolved || projects.length === 0) return;
    if (!projectFromList && !projectError && project === undefined) return;
    const fallback = projects[0];
    if (!fallback || fallback.slug === slug) return;
    fallbackTo(fallback.slug, thread);
  }, [resolved, projects, projectFromList, projectError, project, slug, thread, fallbackTo]);

  // History search (?q= filters title + body snippet server-side); the
  // input is debounced so the query key stops thrashing while typing.
  const [chatSearch, setChatSearch] = useState("");
  const debouncedSearch = useDebouncedValue(chatSearch, 250);
  const listQuery = useHeraldChatList(projectId, debouncedSearch);
  const threads = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  // chatId resolution order: ?thread= > localStorage lexa-chat-last >
  // history list head > "" (fresh empty state). Every applied selection is
  // written back to localStorage.
  const [chatId, setChatId] = useState("");
  const applyChatId = useCallback(
    (id: string) => {
      setChatId(id);
      if (!projectId) return;
      try {
        window.localStorage.setItem(`lexa-chat-last:${projectId}`, id);
      } catch {
        // non-fatal
      }
    },
    [projectId]
  );
  const clearThreadParam = useCallback(() => void navigate({ search: {}, replace: true }), [navigate]);
  const openThreadParam = useCallback((threadId: string) => void navigate({ search: { thread: threadId }, replace: true }), [navigate]);

  // Transcript render on load (GET /api/herald/chat/:chatId). A fresh uuid
  // 404s — that IS the empty-thread state, not an error. HERALD_THREAD_NOT_FOUND
  // is handled silently (no retry, no throw, no console spam) and falls back.
  const transcript = useQuery({
    queryKey: ["herald-chat", chatId],
    queryFn: () => api.getHeraldChat(chatId),
    enabled: !!chatId,
    retry: false,
    throwOnError: false,
    staleTime: Infinity,
  });
  const rawMessages = useMemo(() => transcript.data?.messages ?? [], [transcript.data]);

  const streamKey = chatId ? `herald-chat:${chatId}` : null;
  const stream = useHeraldStream(streamKey);
  const streaming = stream.status === "connecting" || stream.status === "streaming";

  const { turns, setTurns } = useSettledTurns({
    transcriptData: transcript.data,
    transcriptError: transcript.error,
    streaming,
    stream,
  });

  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  // Skill stays OPTIONAL per message — chat starts with none selected and
  // messages go out without one unless picked here (herald-chat.html
  // composer annotation). Changing skill mid-thread mints a fresh thread
  // server-side.
  const [skillId, setSkillId] = useState("");
  // Skills panel collapsed by default on mobile (saves vertical space) and
  // expanded by default on desktop (chip row is the primary selection UI).
  // The viewport is read on mount; subsequent resizes keep the current
  // state — the user can collapse/expand manually and the choice sticks.
  // Narrow screens start collapsed so the tree never starves the content.
  // Static default (same on server + client); the viewport is read once on
  // mount below and the user's manual choice sticks afterwards.
  const { skillsPanelOpen, setSkillsPanelOpen } = useSkillsPanelDefault();
  // Mobile composer treatment: collapse skills by default, flip dropdowns
  // upward so they don't run off the bottom of the screen. Desktop keeps
  // the original behavior (chips visible, dropdowns below).
  const isMobileComposer = isNarrowViewport();
  // Per-turn thinking effort override (herald-chat.html composer): ""
  // follows the project default; an explicit level rides the next stream
  // payload only, then falls back. Resets on thread switch / New chat.
  // Per-turn effort override, scoped to the active chat: switching threads
  // derives back to "" without an effect (no state adjusted after prop).
  const [effortSelection, setEffortSelection] = useState<{ chatId: string; value: HeraldReasoningEffort | "" }>({ chatId: "", value: "" });
  const effort = effortSelection.chatId === chatId ? effortSelection.value : "";
  const setEffort = useCallback(
    (value: HeraldReasoningEffort | "") => setEffortSelection({ chatId, value }),
    [chatId]
  );
  // Chips filter to the Herald Agent junction list — chat ALWAYS runs the
  // herald lane, regardless of the project engine.
  const { skills: heraldSkills, effectiveSkillId, skillName } = chatSkillsOf(agents, skills, skillId);

  const pendingTitleRef = useRef<string | null>(null);
  const ingressInsertedRef = useRef<Set<string>>(new Set());

  // Stale-thread recovery (predicates in herald-chat-logic.ts): a 404
  // transcript that cannot be a fresh deep link, or an orphan ?thread= that
  // never shows up in any list snapshot while the stream is idle.
  const { knownChatIdsRef, initialLastRef } = useThreadKnowledge({ projectId, listData: listQuery.data });

  useEffect(() => {
    const meta = { thread, knownChatIds: knownChatIdsRef.current, initialLast: initialLastRef.current };
    if (!staleThreadNeedsRecovery({ projectId, chatId, transcriptLoading: transcript.isLoading, transcriptError: transcript.error, hasIngress: stream.hasIngress, streaming, listData: listQuery.data, meta })) return;
    recoverStaleThread({ qc, projectId, chatId, listData: listQuery.data, applyChatId, setChatId, clearThreadParam, clearParam: !!thread });
  }, [projectId, chatId, transcript.error, transcript.isLoading, thread, qc, listQuery.data, applyChatId, setChatId, stream.hasIngress, streaming, clearThreadParam, knownChatIdsRef, initialLastRef]);

  useEffect(() => {
    const meta = { thread, knownChatIds: knownChatIdsRef.current, initialLast: initialLastRef.current };
    if (!orphanThreadNeedsRecovery({ projectId, chatId, transcriptError: transcript.error, hasIngress: stream.hasIngress, streaming, listLoading: listQuery.isLoading, listData: listQuery.data, meta })) return;
    recoverStaleThread({ qc, projectId, chatId, listData: listQuery.data, applyChatId, setChatId, clearThreadParam, clearParam: true });
  }, [projectId, chatId, listQuery.data, listQuery.isLoading, thread, stream.hasIngress, streaming, transcript.error, qc, applyChatId, setChatId, clearThreadParam, knownChatIdsRef, initialLastRef]);

  const { engineGate, busy409, attachDisabled, suspendedLock, suspendTally } = chatPageFlags({
    settings,
    settingsLoading,
    turns,
    streamStatus: stream.status,
    streamErrorCode: stream.error?.code,
    streamPendingCount: stream.pending.length,
  });
  const providerMissing = !settingsLoading && settings === null;

  useTerminalRefetch({ stream, chatId, projectId, qc, transcriptError: transcript.error });

  useThreadListIngress({ stream, chatId, projectId, qc, pendingTitleRef, ingressInsertedRef });

  const startStream = useChatStartStream({
    stream,
    projectId,
    chatId,
    applyChatId,
    openThreadParam,
    qc,
    effectiveSkillId,
    effort,
    setEffort,
    pendingTitleRef,
    ingressInsertedRef,
  });

  const send = useCallback(
    (message: string, imageCount = 0) => {
      if (!message || streaming || suspendedLock) return;
      setTurns((prev) => appendEphemeralUserTurn(prev, message, imageCount));
      startStream(message);
    },
    [streaming, suspendedLock, startStream, setTurns]
  );

  const { handleEditSave, handleRegenerate, handleRetryTurn } = useTurnResend({
    turns,
    setTurns,
    rawMessages,
    streaming,
    startStream,
  });

  // Thread switching (History rows / New chat): deep-link via ?thread=.
  // Mid-stream switch aborts the running stream — v1 accepted trade-off.
  const handleAbort = useCallback(() => stream.abort(), [stream]);
  const { handlePinToggle, handleRename, handleDelete, selectThread, startNewChat } = useChatThreadActions({
    projectId,
    chatId,
    setChatId,
    streaming,
    abort: handleAbort,
    clearThreadParam,
    openThreadParam,
  });

  const headerSub = `${resolved?.name ?? ""} · thread with Herald — not tied to any document`;

  // Stable markdown text-leaf hook (mention chips) — identity must hold
  // across stream deltas or the memoized renderer re-lexes every frame.
  const renderText = useCallback((text: string) => renderTokenized(text, slug), [slug]);

  // Last user turn index in display space — regenerate renders only there.
  const lastUserPos = useMemo(() => lastUserIndex(turns), [turns]);

  // Post-stream activity summary (done only) — attached to the trailing
  // assistant turn while this tab's session still holds it.
  const streamActivity = streamDoneActivity({
    status: stream.status,
    items: stream.items,
    tools: stream.tools,
    reasoningMs: stream.reasoningMs,
    reasoningText: stream.reasoningText,
  });

  const { handleDecide, handleApproveAll, batchBusy } = useApprovalDecisions({ setTurns });

  useStreamFrameFreeze({ stream, setTurns, turns, chatId, streaming, ingressInsertedRef });

  const { scrollRef, atBottom, handleTranscriptScroll, scrollToBottom } = useChatAutoScroll({ turns, stream });

  const { editingPos, editDraft, setEditDraft, beginEdit, cancelEdit, commitEdit } = useChatEditing({ turns, onEditSave: handleEditSave });

  return (
    <div className="chat-layout">
      <ThreadsSidebar
        threads={threads}
        activeChatId={chatId}
        search={chatSearch}
        onSearchChange={setChatSearch}
        onSelect={selectThread}
        onNewChat={startNewChat}
        onPinToggle={handlePinToggle}
        onRename={handleRename}
        onDelete={handleDelete}
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="chat-shell">
      <ChatHeader sub={headerSub} />

      {providerMissing ? (
        <ChatProviderMissingPanel projectId={projectId} />
      ) : (
        <>
          <ChatTranscriptArea
            turns={turns ?? []}
            slug={slug}
            streaming={streaming}
            renderText={renderText}
            skillName={skillName}
            projectId={projectId}
            streamActivity={streamActivity}
            batchBusy={batchBusy}
            onDecide={handleDecide}
            onApproveAll={handleApproveAll}
            onRetryTurn={handleRetryTurn}
            scrollRef={scrollRef}
            onScroll={handleTranscriptScroll}
            editingPos={editingPos}
            editDraft={editDraft}
            onEditDraftChange={setEditDraft}
            onBeginEdit={beginEdit}
            onCancelEdit={cancelEdit}
            onCommitEdit={commitEdit}
            lastUserPos={lastUserPos}
            onRegenerate={handleRegenerate}
            stream={stream}
            atBottom={atBottom}
            onJump={() => scrollToBottom(true)}
          />

          <ChatComposerArea
            skillsPanelOpen={skillsPanelOpen}
            onToggleSkills={() => setSkillsPanelOpen((v) => !v)}
            skillName={skillName}
            skills={heraldSkills}
            skillId={effectiveSkillId}
            onSkillChange={setSkillId}
            engineGate={engineGate}
            busy409={busy409}
            slug={slug}
            streaming={streaming}
            suspendedLock={suspendedLock}
            suspendTally={suspendTally}
            attachDisabled={attachDisabled}
            isMobileComposer={isMobileComposer}
            effort={effort}
            projectEffort={settings?.reasoningEffort}
            onEffortChange={setEffort}
            onSend={send}
            onAbort={handleAbort}
          />
        </>
      )}
    </main>
    </div>
  );
}
