import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { useProjects, useAssistantSettings } from "../../lib/queries";
import { useQuery } from "@tanstack/react-query";
import type { AssistantChatThreadSummary } from "../../lib/api";
import { useRenameAssistantChat, useDeleteAssistantChat, useUpdateAssistantChatMeta } from "../../lib/queries";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { useToast } from "../ui/Toast";
import { assistantSendForKey, shouldPersistResume, type ResumeResult } from "../../lib/use-assistant-agent";
import { settleTurnsWithRaw } from "./assistant-chat-turns-state";
import type { ApprovalChip } from "./AssistantApprovals";
import type { ChatTurn } from "./assistant-chat-utils";
import type { ChatAttachmentRef } from "../../lib/assistant-image";
import type { AssistantToolPermissionMode } from "../../../shared/assistant";
import {
  applyChipPatch,
  chatStreamBody,
  chipStateFromError,
  frozenActivity,
  insertNewThread,
  isTerminalStreamStatus,
  isThreadNotFoundCode,
  mergeBatchChips,
  nextTurnsAfterStreamError,
  pendingChipsOf,
  pendingChipTargets,
  resolveResendTarget,
  resumableBatchId,
  suspendTurnFrame,
  terminalTranscriptAction,
  touchThreadEntry,
  truncateTurns,
  threadEntry,
} from "./assistant-chat-logic";

// Session-scoped hooks for the Assistant chat page. These own the refs and
// effects that were inline in AssistantChatPage; the page stays an assembler.

// The chat surface's transport (useAssistantAgent) reports the resume POST's
// HTTP outcome through an optional third parameter; the SSE stream ignores it.
type ResumeCapableStream = Stream & {
  send: (url: string, body: unknown, onResult?: (result: ResumeResult) => void) => void;
};

// A resumed approval batch must never auto-resume twice — the POST re-executes
// the approved writes and is NOT idempotent. Persist the batch id per chat so a
// reload's transcript-driven auto-resume skips it; a FAILED attempt is not
// persisted, so it stays eligible for retry.
const resumedBatchesKey = (chatId: string): string => `lexa-chat-resumed:${chatId}`;

export function readResumedBatches(chatId: string): string[] {
  if (!chatId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(resumedBatchesKey(chatId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function persistResumedBatch(chatId: string, batchId: string): void {
  if (!chatId || typeof window === "undefined") return;
  try {
    const next = Array.from(new Set([...readResumedBatches(chatId), batchId]));
    window.localStorage.setItem(resumedBatchesKey(chatId), JSON.stringify(next));
  } catch {}
}

// Settling pass (plain function so the effect stays a single decision): see
// useStreamFrameFreeze for the freeze/resume contract.
function settleStreamFrame(args: {
  stream: ResumeCapableStream;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  turns: ChatTurn[] | null;
  chatId: string;
  streaming: boolean;
  frozeBatchRef: React.RefObject<string | null>;
  frozeErrorRef: React.RefObject<string | null>;
  resumedBatchesRef: React.RefObject<Set<string>>;
  // Batch ids observed with a pending chip this session. A later all-terminal
  // (rejected/expired) outcome still earns the acknowledgment resume, while a
  // batch that loads terminal from the transcript never does.
  observedPendingRef: React.RefObject<Set<string>>;
  // In-flight resume POSTs keyed `${chatId}:${batchId}`, component-lifetime
  // (never reset on chat switch). The persisted/in-memory `resumedBatchesRef`
  // is per-chat and is re-seeded on selection, so without this a switch away
  // and back while the POST is still in flight would re-issue it (LX-83).
  inFlightResumeRef: React.RefObject<Set<string>>;
  ingressInsertedRef: React.RefObject<Set<string>>;
  // Fired when the resume POST settles into a terminal outcome (executed /
  // settled / indeterminate) — a terminal outcome means any continuation reply
  // is persisted on the DO path (the continuation is awaited before the ack),
  // so the caller refetches the transcript + thread list; the refetch is a safe
  // no-op when nothing new persisted (missing/unsupported/note-less noop). The
  // legacy no-DO SSE fallback resolves at headers before its continuation runs,
  // so the refetch there can be early (that flavor is deprecated). Never fired
  // for pending/unavailable/failure (retryable — no persisted reply yet).
  onResumeSettled?: (() => void) | undefined;
}): void {
  const { stream, setTurns, turns, chatId, streaming, frozeBatchRef, frozeErrorRef, resumedBatchesRef, observedPendingRef, inFlightResumeRef, ingressInsertedRef, onResumeSettled } = args;
  if (stream.status === "suspended") {
    const batchId = stream.suspendedBatchId ?? "";
    const chips = batchId ? pendingChipsOf(stream.pending, batchId) : [];
    if (batchId && frozeBatchRef.current !== batchId) {
      frozeBatchRef.current = batchId;
      const activity = frozenActivity(stream, "suspended");
      setTurns((prev) => [...(prev ?? []), suspendTurnFrame({ batchId, chips, text: stream.text, activity })]);
      stream.reset();
    } else if (batchId) {
      // Carriers of the same batch can straddle several stream frames (the
      // suspension flips on the FIRST chip) — union the rest into the frozen
      // turn so the whole batch stays decidable without a reload.
      setTurns((prev) => mergeBatchChips(prev, batchId, chips));
    }
  }
  if (stream.status === "error" && stream.hasIngress) {
    const key = `${stream.error?.code ?? "ASSISTANT_GENERATION_FAILED"}:${stream.text}:${stream.error?.message ?? ""}`;
    if (frozeErrorRef.current !== key) {
      frozeErrorRef.current = key;
      const activity = frozenActivity(stream, "error");
      const code = stream.error?.code ?? "ASSISTANT_GENERATION_FAILED";
      const error = stream.error ?? { code: "ASSISTANT_GENERATION_FAILED", message: "stream stalled — no response from provider" };
      setTurns((prev) => nextTurnsAfterStreamError(prev, { code, text: stream.text, error, activity }));
    }
  }
  // When EVERY chip of a frozen batch reaches a terminal state the client
  // re-opens the stream for that batch — Assistant continues with a fresh entry.
  // Record any batch that was seen pending this session BEFORE the early return
  // so a later all-terminal outcome (rejected/expired) still earns the
  // acknowledgment resume; transcript-loaded terminal batches are never recorded.
  for (const t of turns ?? []) {
    const b = t.batch;
    if (b && b.chips.some((c) => c.state === "pending")) observedPendingRef.current?.add(b.batchId);
  }
  if (!chatId || streaming) return;
  const batchId = resumableBatchId(turns, resumedBatchesRef.current ?? new Set(), observedPendingRef.current ?? new Set());
  if (batchId === null) return;
  const flightKey = `${chatId}:${batchId}`;
  if (inFlightResumeRef.current?.has(flightKey)) return;
  // In-flight + in-memory add first: dedupes an in-flight POST if the effect
  // re-runs, and the keyed map survives a chat-switch re-seed. Persist only on
  // a settled outcome (executed / settled / indeterminate); `pending` /
  // `unavailable` and an RPC failure un-guard the batch (in-flight + in-memory,
  // no persisted id) so a later pass can retry. The client names the exact
  // batch so the DO executes that batch, never a newer walk.
  inFlightResumeRef.current?.add(flightKey);
  resumedBatchesRef.current?.add(batchId);
  ingressInsertedRef.current?.delete(chatId);
  stream.send(`/api/assistant/chat/${chatId}/resume`, { batchId }, (result) => {
    inFlightResumeRef.current?.delete(flightKey);
    if (shouldPersistResume(result)) {
      persistResumedBatch(chatId, batchId);
      // The continuation ran and its reply is persisted by the time the result
      // arrives — refetch so the resumed assistant entry renders live.
      onResumeSettled?.();
    } else {
      resumedBatchesRef.current?.delete(batchId);
    }
  });
}


// Chip decisions + "Approve all" / "Reject all" (one POST per approvalId; 409s
// flip the chip's terminal state instead of surfacing as toasts).
export function useApprovalDecisions(args: { setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>> }) {
  const { setTurns } = args;
  const toast = useToast();
  const [batchBusy, setBatchBusy] = useState(false);

  const updateChip = useCallback(
    (approvalId: string, patch: Partial<ApprovalChip> & { state: ApprovalChip["state"] }) => {
      setTurns((prev) => applyChipPatch(prev, approvalId, patch));
    },
    [setTurns]
  );

  const handleDecide = useCallback(
    async (chip: ApprovalChip, verdict: "approve" | "reject") => {
      try {
        const res = await api.decideAssistantApproval(chip.approvalId, verdict);
        updateChip(chip.approvalId, { state: res.status === "approved" ? "approved" : "rejected" });
      } catch (e) {
        const err = e as Error & { code?: string | undefined; details?: unknown };
        const state = chipStateFromError(err);
        if (state) updateChip(chip.approvalId, { state });
        else toast.push("error", "Decision failed", err.message);
      }
    },
    [updateChip, toast]
  );

  // Batch decision: one POST per pending chip, sequentially (each response is
  // authoritative for its own chip). Shared by Approve all / Reject all.
  const decideAll = useCallback(
    (chips: ApprovalChip[], verdict: "approve" | "reject") => {
      const targets = pendingChipTargets(chips);
      if (targets.length === 0) return;
      setBatchBusy(true);
      void (async () => {
        try {
          await targets.reduce(
            (chain, chip) => chain.then(() => handleDecide(chip, verdict)),
            Promise.resolve() as Promise<void>
          );
        } finally {
          setBatchBusy(false);
        }
      })();
    },
    [handleDecide]
  );

  const handleApproveAll = useCallback((chips: ApprovalChip[]) => decideAll(chips, "approve"), [decideAll]);
  const handleRejectAll = useCallback((chips: ApprovalChip[]) => decideAll(chips, "reject"), [decideAll]);

  return { updateChip, handleDecide, handleApproveAll, handleRejectAll, batchBusy };
}

type Stream = ReturnType<typeof useAssistantStream>;

// ── Write approvals (assistant-write-approvals.html) ──
// The suspended frame is terminal for the segment: freeze the in-memory
// bubble (activity + text + chips) into the transcript view as an editable
// audit trail, then reset the stream session so the resumed turn starts a
// FRESH assistant entry.
export function useStreamFrameFreeze(args: {
  stream: ResumeCapableStream;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  turns: ChatTurn[] | null;
  chatId: string;
  streaming: boolean;
  ingressInsertedRef: React.RefObject<Set<string>>;
  // The resume POST's terminal outcome — the page refetches the transcript so
  // the server-persisted continuation reply renders live.
  onResumeSettled?: (() => void) | undefined;
}) {
  const { stream, setTurns, turns, chatId, streaming, ingressInsertedRef, onResumeSettled } = args;
  const frozeBatchRef = useRef<string | null>(null);
  const frozeErrorRef = useRef<string | null>(null);
  const resumedBatchesRef = useRef<Set<string>>(new Set());
  const observedPendingRef = useRef<Set<string>>(new Set());
  // Survives chat switches by design (LX-83): the per-chat resumed set below is
  // re-seeded on selection, but an in-flight resume POST must not be re-issued.
  const inFlightResumeRef = useRef<Set<string>>(new Set());
  const chatRef = useRef("");

  // One settling effect (not a chain): freezes the terminal stream frame
  // (suspension or error) into the transcript view, then re-opens any frozen
  // batch whose chips have all reached a terminal state. The freeze setState
  // and the resume pass live in the SAME effect so freezing a frame never
  // spawns a downstream effect — the refs make each branch idempotent. Freeze
  // bookkeeping is per-thread: switching chats resets it first.
  useEffect(() => {
    if (chatRef.current !== chatId) {
      chatRef.current = chatId;
      frozeBatchRef.current = null;
      frozeErrorRef.current = null;
      // Seed with this chat's persisted resumes so a reload's transcript-driven
      // auto-resume skips batches that already succeeded.
      resumedBatchesRef.current = new Set(readResumedBatches(chatId));
    }
    settleStreamFrame({
      stream,
      setTurns,
      turns,
      chatId,
      streaming,
      frozeBatchRef,
      frozeErrorRef,
      resumedBatchesRef,
      observedPendingRef,
      inFlightResumeRef,
      ingressInsertedRef,
      onResumeSettled,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze once per terminal frame; snapshot fields are read at flip time
  }, [stream.status, stream.suspendedBatchId, stream.pending, stream.text, stream.error, stream.items, stream.tools, stream.reasoningMs, stream.reasoningText, stream.hasIngress, turns, chatId, streaming]);

  useEffect(() => {
    if (stream.status === "connecting" || stream.status === "streaming") frozeErrorRef.current = null;
  }, [stream.status]);
}

// Start a stream for the current (or a brand-new) thread; new threads mint a
// uuid, seed the thread list optimistically, and stream via a dedicated key.
export function useChatStartStream(args: {
  stream: Stream;
  projectId: string | undefined;
  chatId: string;
  applyChatId: (id: string) => void;
  openThreadParam: (threadId: string) => void;
  qc: QueryClient;
  effort: string;
  setEffort: (e: "") => void;
  // Send envelope: the thread's authoritative WRITE mode, or undefined when
  // the page has none (unhydrated / un-picked) so the DO keeps its sticky
  // value. The DO captures it at turn start and persists it.
  permissionMode?: AssistantToolPermissionMode | undefined;
  pendingTitleRef: React.RefObject<string | null>;
  ingressInsertedRef: React.RefObject<Set<string>>;
}) {
  const { stream, projectId, chatId, applyChatId, openThreadParam, qc, effort, setEffort, permissionMode, pendingTitleRef, ingressInsertedRef } = args;
  return useCallback(
    (message: string, attachments: ChatAttachmentRef[], fromIndex?: number): string => {
      let threadId = chatId;
      const isNewThread = !threadId;
      if (!threadId) {
        threadId = crypto.randomUUID();
        applyChatId(threadId);
        openThreadParam(threadId);
      }
      pendingTitleRef.current = message.trim();
      if (isNewThread && projectId) {
        const now = new Date().toISOString();
        insertNewThread(qc, projectId, threadId, threadEntry(threadId, message, now));
        ingressInsertedRef.current?.add(threadId);
      } else {
        ingressInsertedRef.current?.delete(threadId);
      }
      const body = chatStreamBody({ projectId, chatId: threadId, message, effort, permissionMode, attachments, fromIndex });
      if (isNewThread) {
        assistantSendForKey(`assistant-chat:${threadId}`, body);
      } else {
        stream.send("/api/assistant/chat/stream", body);
      }
      setEffort("");
      return threadId;
    },
    [stream, projectId, chatId, effort, permissionMode, applyChatId, openThreadParam, qc, setEffort, pendingTitleRef, ingressInsertedRef]
  );
}

// Turns view = settled merge of the server transcript with the live
// optimistic state. Adjusted during render (React derived-state pattern,
// keyed on transcript/stream identity) instead of an effect — the stream
// guards make pure derivation impossible, but the merge stays idempotent.
export function useSettledTurns(args: {
  chatId: string;
  transcriptData: { messages: unknown[] } | undefined;
  transcriptError: unknown;
  streaming: boolean;
  stream: Stream;
  // True while the active chat holds an accepted send whose stream has not yet
  // flipped to connecting/streaming (the fresh-thread write is deferred until
  // the socket identifies). The optimistic user turn must survive the
  // chatId-change derivation; without this the landing repaints.
  sendAccepted?: boolean | undefined;
  // Timestamp of the last successful transcript read (React Query
  // dataUpdatedAt). Reconciliation backfills decision statuses without changing
  // the message count, so the sync key below must also react to a new read —
  // otherwise a remount's GET is swallowed and cached pending chips stay
  // pending. Omitted by callers that don't care about status-only refetches.
  transcriptUpdatedAt?: number | undefined;
}) {
  const { chatId, transcriptData, transcriptError, streaming, stream, sendAccepted = false, transcriptUpdatedAt } = args;
  // Turns ride together with the raw snapshot their rawIndex values point into:
  // after a reconcile the kept turns keep positions from the raw read they were
  // derived from, so resends must resolve against that merged snapshot rather
  // than the shorter live read (M1).
  const [settled, setSettled] = useState<{ turns: ChatTurn[] | null; raw: unknown[] }>({ turns: null, raw: [] });
  const [syncedKey, setSyncedKey] = useState("");
  const chatRef = useRef("");
  // chatId is part of the key: two threads can share a message count and stream
  // status, and without it the previous thread's turns (including a frozen
  // approval batch) would leak into the new one.
  const syncKey = `chat:${chatId}:${transcriptError ? "err" : "ok"}:${transcriptData ? transcriptData.messages.length : "-"}:rev${transcriptUpdatedAt ?? 0}:${stream.status}:${stream.hasIngress}:${streaming}:${sendAccepted}`;
  if (syncedKey !== syncKey) {
    const prevChatId = chatRef.current;
    const chatChanged = prevChatId !== chatId;
    // An accepted send keeps the optimistic turn across the MINT transition
    // only: the id is minted from the empty landing in the same batch as the
    // send, so the "previous chat" null-out would otherwise discard it. Once a
    // real thread id has been applied the exception is spent — re-selecting the
    // accepted chat must NOT carry the intervening thread's turns (nor its live
    // approval chips) into it.
    const keepAcrossChange = sendAccepted && chatChanged && prevChatId === "";
    chatRef.current = chatId;
    setSyncedKey(syncKey);
    setSettled((prev) => {
      const prevTurns = chatChanged && !keepAcrossChange ? null : prev.turns;
      const prevRaw = chatChanged && !keepAcrossChange ? [] : prev.raw;
      if (transcriptError) {
        // A live turn (connecting/streaming, any ingress, or an accepted send
        // whose flush is still pending) means the fresh thread's write is in
        // flight or landed — the 404 is stale, so the optimistic turns (the
        // send's ephemeral user turn) must survive. Only a genuinely dead
        // thread (no stream activity, no ingress) clears.
        if (stream.hasIngress || streaming || keepAcrossChange) return { turns: prevTurns, raw: prevRaw };
        return { turns: [], raw: [] };
      }
      if (!transcriptData) return { turns: prevTurns, raw: prevRaw };
      return settleTurnsWithRaw({
        prev: prevTurns,
        prevRaw,
        messages: transcriptData.messages,
        streaming,
        streamStatus: stream.status,
        hasIngress: stream.hasIngress,
      });
    });
  }
  // External turn mutations (ephemeral append, freeze, truncate) keep the raw
  // snapshot: they only add index -1 turns or drop a tail, so existing rawIndex
  // values stay valid until the next transcript read re-derives both.
  const setTurns = useCallback<React.Dispatch<React.SetStateAction<ChatTurn[] | null>>>((action) => {
    setSettled((s) => ({ turns: typeof action === "function" ? action(s.turns) : action, raw: s.raw }));
  }, []);
  return { turns: settled.turns, setTurns, raw: settled.raw };
}

// Terminal stream frame → refetch the transcript (except 404s, which would
// re-create the dead thread query); the sidebar list always refreshes.
export function useTerminalRefetch(args: {
  stream: Stream;
  chatId: string;
  projectId: string | undefined;
  qc: QueryClient;
  transcriptError: unknown;
}) {
  const { stream, chatId, projectId, qc, transcriptError } = args;
  // One-shot guard for the stale-404 refetch: after ingress the fresh thread
  // exists, so the transcript must be refetched once. If it keeps 404ing, the
  // guard stops an invalidate/error/invalidate loop. Keyed by chat id.
  const refetchedRef = useRef("");
  // Terminal work fires at most once per chat/terminal frame: the stream status
  // can oscillate (a transient recovering tick rewrites `done` → `connecting`)
  // and the status churn must not re-issue the transcript + list invalidations.
  // The guard is per (chat, status) and survives the transient non-terminal
  // flip, so a done→connecting→done oscillation refetches once; a different
  // chat re-arms it.
  const terminalHandledRef = useRef<{ chatId: string; status: string } | null>(null);
  useEffect(() => {
    if (!chatId) {
      terminalHandledRef.current = null;
      return;
    }
    // A genuine turn always passes through "streaming"; the recovering
    // oscillation (done → connecting → done) never does. Re-arm the guard on
    // that edge so a SECOND turn (or a second suspension/abort) in the same
    // chat is handled — keying the guard on (chat, status) alone would suppress
    // it and the settled reply would never reach the transcript.
    if (stream.status === "streaming") {
      terminalHandledRef.current = null;
      return;
    }
    if (!isTerminalStreamStatus(stream.status)) return;
    const handled = terminalHandledRef.current;
    if (handled && handled.chatId === chatId && handled.status === stream.status) return;
    terminalHandledRef.current = { chatId, status: stream.status };
    const code = (transcriptError as { code?: string } | null)?.code;
    if (terminalTranscriptAction(code, stream.hasIngress) === "drop") {
      qc.cancelQueries({ queryKey: ["assistant-chat", chatId] });
      qc.removeQueries({ queryKey: ["assistant-chat", chatId] });
    } else if (isThreadNotFoundCode(code)) {
      // 404 + ingress: the pre-ingress 404 is stale — the thread now exists, so
      // refetch the persisted turns (clearing the 404) instead of dropping the
      // query that would strand the user turn until reload.
      if (refetchedRef.current !== chatId) {
        refetchedRef.current = chatId;
        void qc.invalidateQueries({ queryKey: ["assistant-chat", chatId] });
      }
    } else {
      void qc.invalidateQueries({ queryKey: ["assistant-chat", chatId] });
    }
    if (projectId) void qc.invalidateQueries({ queryKey: ["assistant-chats", projectId] });
  }, [stream.status, stream.hasIngress, chatId, projectId, qc, transcriptError]);
}

// First ingress on a thread: seed/touch its row in the cached thread lists.
export function useThreadListIngress(args: {
  stream: Stream;
  chatId: string;
  projectId: string | undefined;
  qc: QueryClient;
  pendingTitleRef: React.RefObject<string | null>;
  ingressInsertedRef: React.RefObject<Set<string>>;
}) {
  const { stream, chatId, projectId, qc, pendingTitleRef, ingressInsertedRef } = args;
  useEffect(() => {
    if (!projectId || !chatId) return;
    if (!stream.hasIngress) return;
    if (ingressInsertedRef.current?.has(chatId)) return;
    ingressInsertedRef.current?.add(chatId);
    const entry = threadEntry(chatId, pendingTitleRef.current ?? "", new Date().toISOString());
    touchThreadEntry(qc, projectId, entry);
  }, [stream.hasIngress, chatId, projectId, qc, pendingTitleRef, ingressInsertedRef]);
}

// Edit/regenerate/retry: optimistic truncate + resend from the raw index.
// The trigger is resolved against the RAW transcript (an optimistic display
// turn maps back to its raw user message); an unmappable trigger is surfaced
// as a toast, never a silent no-op that would drop the user's prompt.
export function useTurnResend(args: {
  turns: ChatTurn[] | null;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  rawMessages: unknown[];
  streaming: boolean;
  startStream: (message: string, attachments: ChatAttachmentRef[], fromIndex?: number) => void;
}) {
  const { turns, setTurns, rawMessages, streaming, startStream } = args;
  const toast = useToast();

  const resendFailed = () =>
    toast.push("error", "Couldn’t resend turn", "This turn isn’t saved with this text yet — try again in a moment.");

  const handleEditSave = (target: ChatTurn, draft: string) => {
    const message = draft.trim();
    if (!message || streaming) return;
    const resolved = resolveResendTarget({ turns, target, rawMessages, mode: "edit" });
    if (!resolved) {
      resendFailed();
      return;
    }
    setTurns((prev) => truncateTurns(prev, resolved.turn, message));
    startStream(message, resolved.turn.attachments ?? [], resolved.index);
  };

  // Regenerate exists ONLY on the last user turn: resends that message and
  // replaces the trailing assistant reply.
  const handleRegenerate = (target: ChatTurn) => {
    if (streaming) return;
    const resolved = resolveResendTarget({ turns, target, rawMessages, mode: "regenerate" });
    if (!resolved) {
      resendFailed();
      return;
    }
    setTurns((prev) => truncateTurns(prev, resolved.turn));
    startStream(resolved.turn.text, resolved.turn.attachments ?? [], resolved.index);
  };

  // Retry on a failed/stopped bubble resends ITS triggering user message
  // (with its original attachment refs — D6) from that point without
  // duplicating the failed turn.
  const handleRetryTurn = (assistantTurn: ChatTurn) => {
    if (streaming) return;
    const resolved = resolveResendTarget({ turns, target: assistantTurn, rawMessages, mode: "retry" });
    if (!resolved) {
      resendFailed();
      return;
    }
    setTurns((prev) => truncateTurns(prev, resolved.turn));
    startStream(resolved.turn.text, resolved.turn.attachments ?? [], resolved.index);
  };

  return { handleEditSave, handleRegenerate, handleRetryTurn };
}

// Thread switching / history actions (History rows, New chat): deep-link
// via ?thread=; deleting the active thread resets to the fresh empty state.
// Mid-stream switch aborts the running stream — v1 accepted trade-off.
export function useChatThreadActions(args: {
  projectId: string | undefined;
  chatId: string;
  applyChatId: (id: string) => void;
  setChatId: (id: string) => void;
  streaming: boolean;
  abort: () => void;
  clearThreadParam: () => void;
  stripThreadParam: () => void;
  openThreadParam: (threadId: string) => void;
}) {
  const { projectId, chatId, applyChatId, setChatId, streaming, abort, clearThreadParam, stripThreadParam, openThreadParam } = args;
  const renameChat = useRenameAssistantChat(projectId);
  const deleteChat = useDeleteAssistantChat(projectId);
  const metaChat = useUpdateAssistantChatMeta(projectId);
  const handlePinToggle = useCallback((id: string, pinned: boolean) => void metaChat.mutateAsync({ chatId: id, pinned }), [metaChat]);
  const handleRename = useCallback((id: string, title: string) => renameChat.mutateAsync({ chatId: id, title }), [renameChat]);
  const handleDelete = useCallback(
    (id: string) =>
      deleteChat.mutateAsync({ chatId: id }).then(() => {
        if (id === chatId) {
          // Land on the fresh empty chat (herald-chat.html: the view lands on a
          // fresh empty chat).
          try {
            window.localStorage.removeItem(`lexa-chat-last:${projectId}`);
          } catch {}
          setChatId("");
          clearThreadParam();
        }
      }),
    [deleteChat, chatId, projectId, clearThreadParam, setChatId]
  );
  const selectThread = useCallback(
    (id: string) => {
      if (streaming) abort();
      // Apply immediately (state + last-visited) — the deep link alone only
      // changes the URL and would leave the transcript on the old thread.
      applyChatId(id);
      openThreadParam(id);
    },
    [streaming, abort, applyChatId, openThreadParam]
  );
  const startNewChat = useCallback(() => {
    if (streaming) abort();
    // "New chat" clears to the fresh landing purely client-side: the next send
    // mints the uuid (useChatStartStream). The ?thread= param is stripped with
    // replaceState (no router navigation → no ssr:false route-loader flash) so a
    // remount/reload cannot re-open the thread the user left; navigating here
    // would re-run the loader and flash the shell.
    try {
      window.localStorage.removeItem(`lexa-chat-last:${projectId}`);
    } catch {}
    stripThreadParam();
    setChatId("");
  }, [streaming, abort, projectId, setChatId, stripThreadParam]);
  return { handlePinToggle, handleRename, handleDelete, selectThread, startNewChat };
}

// Inline message editing state (user turns): one editor at a time, draft
// scoped to the edited position.
export function useChatEditing(args: {
  chatId: string;
  turns: ChatTurn[] | null;
  onEditSave: (target: ChatTurn, draft: string) => void;
}) {
  const { chatId, turns, onEditSave } = args;
  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // An editor belongs to one thread — switching chats must not carry a draft
  // (or editing position) into the next transcript.
  useEffect(() => {
    setEditingPos(null);
    setEditDraft("");
  }, [chatId]);
  const beginEdit = useCallback(
    (pos: number) => {
      setEditingPos(pos);
      setEditDraft((turns ?? [])[pos]?.text ?? "");
    },
    [turns]
  );
  const cancelEdit = useCallback(() => {
    setEditingPos(null);
    setEditDraft("");
  }, []);
  const commitEdit = useCallback(
    (pos: number) => {
      const target = (turns ?? [])[pos];
      if (!target) {
        setEditingPos(null);
        setEditDraft("");
        return;
      }
      onEditSave(target, editDraft);
      setEditingPos(null);
      setEditDraft("");
    },
    [turns, onEditSave, editDraft]
  );
  return { editingPos, editDraft, setEditDraft, beginEdit, cancelEdit, commitEdit };
}

// Project resolution + settings for the chat page (slug-keyed; chatId is
// resolved by the page afterwards). No state — pure data plumbing.
export function useChatProjectQueries(args: { slug: string }) {
  const { slug } = args;
  const { data: projects = [] } = useProjects();
  const projectFromList = projects.find((p) => p.slug === slug);
  const { data: project, isError: projectError } = useQuery({
    queryKey: ["project", slug],
    queryFn: () => api.getProject(slug),
    enabled: !projectFromList,
    // Invalid slug must fall back fast — no retry ladder (default is 3
    // attempts ≈7s of dead shell before the redirect).
    retry: false,
  });
  const resolved = projectFromList ?? project;
  const projectId = resolved?.id;
  const { data: settings, isLoading: settingsLoading } = useAssistantSettings(projectId);
  return { projects, projectFromList, projectError, project, resolved, projectId, settings, settingsLoading };
}

// Ref knowledge for stale-thread recovery: the persisted last-visited at
// mount and every chat id seen in a list snapshot. Effects only touch refs.
export function useThreadKnowledge(args: { projectId: string | undefined; listData: AssistantChatThreadSummary[] | undefined }) {
  const { projectId, listData } = args;
  const knownChatIdsRef = useRef<Set<string>>(new Set());
  const initialLastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    try {
      initialLastRef.current = window.localStorage.getItem(`lexa-chat-last:${projectId}`);
    } catch {}
  }, [projectId]);
  useEffect(() => {
    if (listData) {
      for (const t of listData) knownChatIdsRef.current.add(t.chatId);
    }
  }, [listData]);
  return { knownChatIdsRef, initialLastRef };
}
