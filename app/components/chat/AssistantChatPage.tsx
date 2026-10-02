import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as api from "../../lib/api";
import {
  useAgents,
  useSkills,
  useAssistantChatList,
  useCapabilities,
  useChatAttachments,
  useUploadChatAttachment,
} from "../../lib/queries";
import { useAssistantAgent } from "../../lib/use-assistant-agent";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { isNarrowViewport } from "../../lib/viewport";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { ThreadsSidebar } from "./ThreadsSidebar";
import type { AssistantReasoningEffort, AssistantToolPermissionMode } from "../../../shared/assistant";
import { useChatSidebar, useChatAutoScroll } from "./assistant-chat-hooks";
import { useChatQueue } from "./useChatQueue";
import { ChatLanding } from "./ChatLanding";
import {
  chatPageFlags,
  chatSkillsOf,
  lastUserIndex,
  streamDoneActivity,
  appendEphemeralUserTurn,
  orphanThreadNeedsRecovery,
  dropUnknownThread,
  resolveChatId,
  resolvePermissionMode,
  isPermissionAuthoritative,
  noWriteToolsAllowed,
  staleThreadNeedsRecovery,
  isThreadNotFound,
} from "./assistant-chat-logic";
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
} from "./assistant-chat-session";
import { ChatProviderMissingPanel } from "./AssistantChatTurns";
import type { ChatUploadRequest } from "./AssistantChatComposer";
import { ChatComposerArea, ChatHeader, ChatTranscriptArea } from "./AssistantChatShell";
import type { ChatAttachment } from "../../lib/api";
import type { ChatAttachmentRef } from "../../lib/assistant-image";

// Assistant Chat — dedicated /$slug/chat route (assistant-chat.html +
// assistant-chat-upgrades.html). Multi-thread per (project, user): the
// History dropdown lists threads (?thread= deep link), each thread keeps a
// client uuid in document_id. An explicit ?thread= deep link or a sidebar row
// selects a thread; with no deep link the last active thread
// (lexa-chat-last:<projectId>) is restored so a run that survived a navigation
// re-attaches (LX-8) — stale-thread recovery also uses that key to tell a
// brand-new deep-linked thread from a known one. No queue row — streams are
// direct SSE.
// No agent picker: the persona mirrors the project's configured Assistant Agent
// (read-only); skills are invoked per message with `$name`. Transcript
// affordances (hover copy/edit/regenerate, citation chips,
// failed/interrupted treatments) transcribe assistant-chat-upgrades.html.



export function AssistantChatPage({ slug, thread }: { slug: string; thread?: string | undefined }) {
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
  // (assistant-chat.html, mirroring the wiki sidebar); persists in localStorage
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
  const listQuery = useAssistantChatList(projectId, debouncedSearch);
  const threads = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  // chatId resolution: ?thread= deep link wins; otherwise the last active
  // thread (lexa-chat-last:<projectId>) is restored so a run that survived a
  // navigation re-attaches (LX-8). Everything else is the fresh landing. Every
  // applied selection is written back to localStorage (lexa-chat-last:<projectId>)
  // for stale-thread recovery — and, with no deep link, to drive the default
  // restore above.
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

  // Resolve the active thread: an explicit ?thread= deep link wins; otherwise
  // the last active thread (`lexa-chat-last:<projectId>`) is restored so a run
  // that survived a navigation re-attaches (LX-8). An already-active selection
  // is never clobbered — except on a project switch, where the previous
  // project's thread must not leak. Deleting the ACTIVE thread clears the
  // memory and lands on a fresh empty chat (herald-chat.html "The view lands on
  // a fresh empty chat"), NOT the next list head.
  // Which project's thread resolution has settled — the landing must not paint
  // before the resolve effect has run, or a hard load / deep link flashes the
  // hero over a project that actually has threads.
  const [resolutionProject, setResolutionProject] = useState<string | undefined>(undefined);

  const resolvedProjectRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!projectId) return;
    const projectChanged = resolvedProjectRef.current !== projectId;
    resolvedProjectRef.current = projectId;
    let lastVisited: string | null = null;
    try {
      lastVisited = window.localStorage.getItem(`lexa-chat-last:${projectId}`);
    } catch {
      // non-fatal
    }
    const next = resolveChatId({
      projectId,
      thread,
      currentChatId: projectChanged ? "" : chatId,
      lastVisited,
    });
    if (next) applyChatId(next);
    else if (projectChanged && chatId) setChatId("");
    setResolutionProject(projectId);
  }, [projectId, thread, chatId, applyChatId]);

  // Transcript render on load (GET /api/assistant/chat/:chatId). A fresh uuid
  // 404s — that IS the empty-thread state, not an error. ASSISTANT_THREAD_NOT_FOUND
  // is handled silently (no retry, no throw, no console spam) and falls back.
  const transcript = useQuery({
    queryKey: ["assistant-chat", chatId],
    queryFn: () => api.getAssistantChat(chatId),
    enabled: !!chatId,
    retry: false,
    throwOnError: false,
    staleTime: Infinity,
  });
  const rawMessages = useMemo(() => transcript.data?.messages ?? [], [transcript.data]);

  // A cached transcript must be re-read whenever its thread becomes active:
  // GET /assistant/chat/:chatId reconciles persisted approval markers against
  // live decisions (terminal chip statuses only the read carries). chatId
  // resolves in an effect AFTER mount, so the query observer mounts disabled and
  // `refetchOnMount` cannot fire on the enabled flip; without this explicit read
  // an SPA round trip (leave the chat, come back) re-renders the cached
  // pre-decision marker as pending chips, and approving then 409s
  // APPROVAL_ALREADY_DECIDED. Fresh threads (no cached data) are left to the
  // mount fetch; a fetch already in flight is not duplicated.
  const reconciledChatRef = useRef("");
  useEffect(() => {
    if (!chatId) return;
    if (reconciledChatRef.current === chatId) return;
    reconciledChatRef.current = chatId;
    const state = qc.getQueryState(["assistant-chat", chatId]);
    if (!state || state.data === undefined || state.fetchStatus === "fetching") return;
    void qc.refetchQueries({ queryKey: ["assistant-chat", chatId], exact: true, type: "active" });
  }, [chatId, qc]);

  const streamKey = chatId ? `assistant-chat:${chatId}` : null;
  const stream = useAssistantAgent(streamKey);
  const streaming = stream.status === "connecting" || stream.status === "streaming";

  const { turns, setTurns } = useSettledTurns({
    chatId,
    transcriptData: transcript.data,
    transcriptError: transcript.error,
    streaming,
    stream,
    transcriptUpdatedAt: transcript.dataUpdatedAt,
  });

  const { data: agents = [] } = useAgents();
  const { data: skills = [] } = useSkills();
  // Mobile composer treatment: collapse the rail to the effort summary chip
  // and flip dropdowns upward so they don't run off the bottom of the screen.
  // Desktop keeps the original behavior (labels visible, dropdowns below).
  const isMobileComposer = isNarrowViewport();
  // Per-turn thinking effort override (assistant-chat.html composer): ""
  // follows the project default; an explicit level rides the next stream
  // payload only, then falls back. Resets on thread switch / New chat.
  // Per-turn effort override, scoped to the active chat: switching threads
  // derives back to "" without an effect (no state adjusted after prop).
  const [effortSelection, setEffortSelection] = useState<{ chatId: string; value: AssistantReasoningEffort | "" }>({ chatId: "", value: "" });
  const effort = effortSelection.chatId === chatId ? effortSelection.value : "";
  const setEffort = useCallback(
    (value: AssistantReasoningEffort | "") => setEffortSelection({ chatId, value }),
    [chatId]
  );
  // Per-thread WRITE-tool permission mode (herald-chat.html rail, beside
  // Effort). Sticky: the in-session pick wins for the active thread; a thread
  // without a pick seeds from its transcript value (fallback "ask"). Keyed by
  // chatId so switching threads shows that thread's own mode.
  const [permissionSelection, setPermissionSelection] = useState<{ chatId: string; value: AssistantToolPermissionMode } | null>(null);
  const transcriptPermissionMode = transcript.data?.chatId === chatId ? transcript.data.permissionMode : undefined;
  const permissionMode = resolvePermissionMode({
    chatId,
    selection: permissionSelection,
    transcriptChatId: transcript.data?.chatId,
    transcriptMode: transcriptPermissionMode,
  });
  // Envelope guard: only an in-session pick for this thread or a loaded
  // transcript proves the mode; otherwise the send omits `permissionMode` so
  // the DO keeps its sticky value. Display still falls back to "ask".
  const permissionAuthoritative = isPermissionAuthoritative({
    chatId,
    selection: permissionSelection,
    transcriptChatId: transcript.data?.chatId,
  });
  const setPermissionMode = useCallback(
    (value: AssistantToolPermissionMode) => setPermissionSelection({ chatId, value }),
    [chatId]
  );
  // The project allowlist gate (W1 State 4): with no write tools allowed, the
  // Writes control locks and shows its hint line. Only a settled, successful
  // settings read can prove the list is empty.
  const noWriteTools = noWriteToolsAllowed(settings, settingsLoading);
  // Chips filter to the Assistant Agent junction list — chat ALWAYS runs the
  // assistant lane, regardless of the project engine. The `$` popup consumes
  // this bound list.
  const assistantSkills = useMemo(() => chatSkillsOf(agents, skills), [agents, skills]);

  const pendingTitleRef = useRef<string | null>(null);
  const ingressInsertedRef = useRef<Set<string>>(new Set());

  // Stale-thread recovery (predicates in assistant-chat-logic.ts): a 404
  // transcript that cannot be a fresh deep link, or an orphan ?thread= that
  // never shows up in any list snapshot while the stream is idle. Either way
  // the destination is the fresh chat landing — never a list head.
  const { knownChatIdsRef, initialLastRef } = useThreadKnowledge({ projectId, listData: listQuery.data });

  useEffect(() => {
    const meta = { thread, knownChatIds: knownChatIdsRef.current, initialLast: initialLastRef.current };
    if (!staleThreadNeedsRecovery({ projectId, chatId, transcriptLoading: transcript.isLoading, transcriptError: transcript.error, hasIngress: stream.hasIngress, streaming, listData: listQuery.data, meta })) return;
    dropUnknownThread({ qc, projectId, chatId, setChatId, clearThreadParam, clearParam: !!thread });
  }, [projectId, chatId, transcript.error, transcript.isLoading, thread, qc, listQuery.data, setChatId, stream.hasIngress, streaming, clearThreadParam, knownChatIdsRef, initialLastRef]);

  useEffect(() => {
    const meta = { thread, knownChatIds: knownChatIdsRef.current, initialLast: initialLastRef.current };
    if (!orphanThreadNeedsRecovery({ projectId, chatId, transcriptError: transcript.error, hasIngress: stream.hasIngress, streaming, listLoading: listQuery.isLoading, listData: listQuery.data, meta })) return;
    dropUnknownThread({ qc, projectId, chatId, setChatId, clearThreadParam, clearParam: true });
  }, [projectId, chatId, listQuery.data, listQuery.isLoading, thread, stream.hasIngress, streaming, transcript.error, qc, setChatId, clearThreadParam, knownChatIdsRef, initialLastRef]);

  const { busy409, attachDisabled, suspendedLock, suspendPendingCount } = chatPageFlags({
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
    effort,
    setEffort,
    permissionMode: permissionAuthoritative ? permissionMode : undefined,
    pendingTitleRef,
    ingressInsertedRef,
  });

  // LX-2 attachments: the deployment kill switch (absent on older builds →
  // enabled), the active thread's uploaded rows (storageKey → row, resolves
  // sent refs to serve URLs + sizes on reload), and the XHR upload mutation.
  const capabilities = useCapabilities();
  const attachmentsEnabled = capabilities.isFetched && capabilities.data?.chatAttachments !== false;
  const attachmentQuery = useChatAttachments(slug, chatId);
  const attachmentIndex = useMemo(
    () => new Map<string, ChatAttachment>((attachmentQuery.data ?? []).map((a) => [a.storageKey, a])),
    [attachmentQuery.data]
  );
  const uploadMutation = useUploadChatAttachment(slug);
  const uploadAttachment = useCallback(
    (req: ChatUploadRequest) => uploadMutation.mutateAsync(req),
    [uploadMutation]
  );
  // Uploads are thread-scoped: mint the thread id at pick time so a file can be
  // uploaded before the first send, then reuse that id for the send. The
  // composer's startStream mints an id too, but this makes both agree.
  const ensureChatId = useCallback((): string => {
    if (chatId) return chatId;
    const id = crypto.randomUUID();
    applyChatId(id);
    openThreadParam(id);
    return id;
  }, [chatId, applyChatId, openThreadParam]);

  // Returns whether the send was accepted — the composer only clears its draft
  // / held queue + attachments on an accepted send, so a refused flush can
  // never destroy a held message.
  const send = useCallback(
    (message: string, attachments: ChatAttachmentRef[]): boolean => {
      if (!message || streaming || suspendedLock) return false;
      setTurns((prev) => appendEphemeralUserTurn(prev, message, attachments));
      const threadId = startStream(message, attachments);
      // Carry an AUTHORITATIVE mode onto the (possibly just-minted) thread so
      // the picker stays in sync before its transcript is read back. A display
      // fallback must NOT be stored — it would later override transcript
      // hydration and stamp a spurious "ask" onto the thread's sticky value.
      if (permissionAuthoritative) setPermissionSelection({ chatId: threadId, value: permissionMode });
      return true;
    },
    [streaming, suspendedLock, startStream, setTurns, permissionMode, permissionAuthoritative]
  );

  // Client-only one-message queue (assistant-chat-deck §3.3): a message typed
  // while the turn runs is held in page memory and flushed by the clean `done`
  // transition, or kept held after aborted/error until sent explicitly.
  const { queued, enqueue, unqueue } = useChatQueue({ chatId, streamStatus: stream.status, send });

  // Zero-turn landing (assistant-chat-deck §3.5): hero + centered Deck + starter
  // chips, shown for a SETTLED, zero-turn chat with a provider configured — with
  // or without a thread id. "New chat" mints a fresh ?thread=<uuid> and a fresh
  // uuid deep link is the same empty thread (transcript 404s), so the landing
  // must not depend on the id being absent; a real thread with turns docks
  // instead. Gated on the resolution effect having run + settings/list settled +
  // the transcript not loading (and, if it errored, that error being a clean
  // not-found rather than a transient read failure), so a hard load / deep link
  // never paints the hero over a thread that is still resolving or that failed
  // to load for a reason other than absence. `transcript.isLoading` is false when
  // the query is disabled for an empty chatId.
  const threadResolutionSettled = !!projectId && resolutionProject === projectId;
  const isLanding =
    !providerMissing &&
    threadResolutionSettled &&
    !settingsLoading &&
    !listQuery.isLoading &&
    !transcript.isLoading &&
    (!transcript.error || isThreadNotFound(transcript.error)) &&
    (turns?.length ?? 0) === 0 &&
    !streaming;
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  // A starter-chip seed prefills the composer draft once. Once a turn exists the
  // draft is no longer a fresh landing, so drop the seed: otherwise returning to
  // the landing (chip → send → delete active thread) would remount the composer
  // and refill the draft with the stale chip text.
  useEffect(() => {
    if ((turns?.length ?? 0) > 0) setSeed(null);
  }, [turns?.length]);

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
    applyChatId,
    setChatId,
    streaming,
    abort: handleAbort,
    clearThreadParam,
    openThreadParam,
  });

  const activeThread = useMemo(() => threads.find((t) => t.chatId === chatId) ?? null, [threads, chatId]);

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

  const { handleDecide, handleApproveAll, handleRejectAll, batchBusy } = useApprovalDecisions({ setTurns });

  useStreamFrameFreeze({ stream, setTurns, turns, chatId, streaming, ingressInsertedRef });

  const { scrollRef, atBottom, handleTranscriptScroll, scrollToBottom } = useChatAutoScroll({ turns, stream });

  const { editingPos, editDraft, setEditDraft, beginEdit, cancelEdit, commitEdit } = useChatEditing({ chatId, turns, onEditSave: handleEditSave });

  return (
    <div className="chat-layout">
      <ThreadsSidebar
        threads={threads}
        activeChatId={chatId}
        search={chatSearch}
        onSearchChange={setChatSearch}
        onSelect={selectThread}
        onNewChat={startNewChat}
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="chat-shell">
      <ChatHeader
        landing={isLanding}
        loading={listQuery.isLoading || transcript.isLoading}
        title={activeThread?.title ?? null}
        projectName={resolved?.name ?? ""}
        updatedAt={activeThread?.updatedAt ?? null}
        pinned={!!activeThread?.pinned}
        actionsDisabled={streaming || suspendedLock || listQuery.isLoading}
        onRename={(next) => void handleRename(chatId, next)}
        onPinToggle={() => void handlePinToggle(chatId, !(activeThread?.pinned ?? false))}
        onDelete={() => handleDelete(chatId)}
      />

      {providerMissing ? (
        <ChatProviderMissingPanel projectId={projectId} />
      ) : isLanding ? (
        <ChatLanding onPickStarter={(text) => setSeed({ text, nonce: Date.now() })}>
          <ChatComposerArea
            skills={assistantSkills}
            busy409={busy409}
            slug={slug}
            streaming={streaming}
            suspendedLock={suspendedLock}
            suspendCount={suspendPendingCount}
            attachDisabled={attachDisabled}
            isMobileComposer={isMobileComposer}
            effort={effort}
            projectEffort={settings?.reasoningEffort}
            onEffortChange={setEffort}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            noWriteTools={noWriteTools}
            onSend={send}
            onAbort={handleAbort}
            landing={isLanding}
            queued={queued}
            onQueue={(text) => enqueue(text)}
            onUnqueue={unqueue}
            seed={seed}
            streamStatus={stream.status}
            sendError={stream.error}
            reconnecting={stream.reconnecting}
            resumed={stream.resumed}
            attachmentsEnabled={attachmentsEnabled}
            ensureChatId={ensureChatId}
            uploadAttachment={uploadAttachment}
          />
        </ChatLanding>
      ) : (
        <>
          <ChatTranscriptArea
            turns={turns ?? []}
            slug={slug}
            streaming={streaming}
            renderText={renderText}
            projectId={projectId}
            streamActivity={streamActivity}
            batchBusy={batchBusy}
            onDecide={handleDecide}
            onApproveAll={handleApproveAll}
            onRejectAll={handleRejectAll}
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
            attachmentIndex={attachmentIndex}
          />

          <ChatComposerArea
            skills={assistantSkills}
            busy409={busy409}
            slug={slug}
            streaming={streaming}
            suspendedLock={suspendedLock}
            suspendCount={suspendPendingCount}
            attachDisabled={attachDisabled}
            isMobileComposer={isMobileComposer}
            effort={effort}
            projectEffort={settings?.reasoningEffort}
            onEffortChange={setEffort}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            noWriteTools={noWriteTools}
            onSend={send}
            onAbort={handleAbort}
            landing={isLanding}
            queued={queued}
            onQueue={(text) => enqueue(text)}
            onUnqueue={unqueue}
            seed={seed}
            streamStatus={stream.status}
            sendError={stream.error}
            reconnecting={stream.reconnecting}
            resumed={stream.resumed}
            attachmentsEnabled={attachmentsEnabled}
            ensureChatId={ensureChatId}
            uploadAttachment={uploadAttachment}
          />
        </>
      )}
    </main>
    </div>
  );
}
