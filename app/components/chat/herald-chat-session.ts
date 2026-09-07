import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { useProjects, useHeraldSettings } from "../../lib/queries";
import { useQuery } from "@tanstack/react-query";
import type { HeraldChatThreadSummary } from "../../lib/api";
import { useRenameHeraldChat, useDeleteHeraldChat, useUpdateHeraldChatMeta } from "../../lib/queries";
import type { useHeraldStream } from "../../lib/use-herald-stream";
import { useToast } from "../ui/Toast";
import { heraldSendForKey } from "../../lib/use-herald-stream";
import { settleTurns } from "./herald-chat-turns-state";
import { resendIndex } from "../../lib/resendIndex";
import type { ApprovalChip } from "./HeraldApprovals";
import type { ChatTurn } from "./herald-chat-utils";
import {
  applyChipPatch,
  chatStreamBody,
  chipStateFromError,
  frozenActivity,
  insertNewThread,
  isTerminalStreamStatus,
  isThreadNotFoundCode,
  nextTurnsAfterStreamError,
  pendingChipsOf,
  pendingChipTargets,
  previousUserTurn,
  resumableBatchId,
  suspendTurnFrame,
  touchThreadEntry,
  truncateTurns,
  threadEntry,
} from "./herald-chat-logic";

// Session-scoped hooks for the Herald chat page. These own the refs and
// effects that were inline in HeraldChatPage; the page stays an assembler.

// Settling pass (plain function so the effect stays a single decision): see
// useStreamFrameFreeze for the freeze/resume contract.
function settleStreamFrame(args: {
  stream: Stream;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  turns: ChatTurn[] | null;
  chatId: string;
  streaming: boolean;
  frozeBatchRef: React.RefObject<string | null>;
  frozeErrorRef: React.RefObject<string | null>;
  resumedBatchesRef: React.RefObject<Set<string>>;
  ingressInsertedRef: React.RefObject<Set<string>>;
}): void {
  const { stream, setTurns, turns, chatId, streaming, frozeBatchRef, frozeErrorRef, resumedBatchesRef, ingressInsertedRef } = args;
  if (stream.status === "suspended") {
    const batchId = stream.suspendedBatchId ?? "";
    if (batchId && frozeBatchRef.current !== batchId) {
      frozeBatchRef.current = batchId;
      const chips = pendingChipsOf(stream.pending, batchId);
      const activity = frozenActivity(stream, "suspended");
      setTurns((prev) => [...(prev ?? []), suspendTurnFrame({ batchId, chips, text: stream.text, activity })]);
      stream.reset();
    }
  }
  if (stream.status === "error" && stream.hasIngress) {
    const key = `${stream.error?.code ?? "HERALD_GENERATION_FAILED"}:${stream.text}:${stream.error?.message ?? ""}`;
    if (frozeErrorRef.current !== key) {
      frozeErrorRef.current = key;
      const activity = frozenActivity(stream, "error");
      const code = stream.error?.code ?? "HERALD_GENERATION_FAILED";
      const error = stream.error ?? { code: "HERALD_GENERATION_FAILED", message: "stream stalled — no response from provider" };
      setTurns((prev) => nextTurnsAfterStreamError(prev, { code, text: stream.text, error, activity }));
    }
  }
  // When EVERY chip of a frozen batch reaches a terminal state the client
  // re-opens the stream for that batch — Herald continues with a fresh entry.
  if (!chatId || streaming) return;
  const batchId = resumableBatchId(turns, resumedBatchesRef.current ?? new Set());
  if (batchId === null) return;
  resumedBatchesRef.current?.add(batchId);
  ingressInsertedRef.current?.delete(chatId);
  stream.send(`/api/herald/chat/${chatId}/resume`, {});
}


// Chip decisions + "Approve all" (one POST per approvalId; 409s flip the
// chip's terminal state instead of surfacing as toasts).
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
        const res = await api.decideHeraldApproval(chip.approvalId, verdict);
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

  const handleApproveAll = useCallback(
    (chips: ApprovalChip[]) => {
      const targets = pendingChipTargets(chips);
      if (targets.length === 0) return;
      setBatchBusy(true);
      void (async () => {
        try {
          await targets.reduce(
            (chain, chip) => chain.then(() => handleDecide(chip, "approve")),
            Promise.resolve() as Promise<void>
          );
        } finally {
          setBatchBusy(false);
        }
      })();
    },
    [handleDecide]
  );

  return { updateChip, handleDecide, handleApproveAll, batchBusy };
}

type Stream = ReturnType<typeof useHeraldStream>;

// ── Write approvals (herald-write-approvals.html) ──
// The suspended frame is terminal for the segment: freeze the in-memory
// bubble (activity + text + chips) into the transcript view as an editable
// audit trail, then reset the stream session so the resumed turn starts a
// FRESH assistant entry.
export function useStreamFrameFreeze(args: {
  stream: Stream;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  turns: ChatTurn[] | null;
  chatId: string;
  streaming: boolean;
  ingressInsertedRef: React.RefObject<Set<string>>;
}) {
  const { stream, setTurns, turns, chatId, streaming, ingressInsertedRef } = args;
  const frozeBatchRef = useRef<string | null>(null);
  const frozeErrorRef = useRef<string | null>(null);
  const resumedBatchesRef = useRef<Set<string>>(new Set());

  // One settling effect (not a chain): freezes the terminal stream frame
  // (suspension or error) into the transcript view, then re-opens any frozen
  // batch whose chips have all reached a terminal state. The freeze setState
  // and the resume pass live in the SAME effect so freezing a frame never
  // spawns a downstream effect — the refs make each branch idempotent.
  useEffect(() => {
    settleStreamFrame({
      stream,
      setTurns,
      turns,
      chatId,
      streaming,
      frozeBatchRef,
      frozeErrorRef,
      resumedBatchesRef,
      ingressInsertedRef,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freeze once per terminal frame; snapshot fields are read at flip time
  }, [stream.status, stream.suspendedBatchId, stream.pending, stream.text, stream.error, stream.items, stream.tools, stream.reasoningMs, stream.reasoningText, stream.hasIngress, turns, chatId, streaming]);

  useEffect(() => {
    frozeErrorRef.current = null;
  }, [chatId]);
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
  effectiveSkillId: string;
  effort: string;
  setEffort: (e: "") => void;
  pendingTitleRef: React.RefObject<string | null>;
  ingressInsertedRef: React.RefObject<Set<string>>;
}) {
  const { stream, projectId, chatId, applyChatId, openThreadParam, qc, effectiveSkillId, effort, setEffort, pendingTitleRef, ingressInsertedRef } = args;
  return useCallback(
    (message: string, fromIndex?: number) => {
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
      const body = chatStreamBody({ projectId, chatId: threadId, message, skillId: effectiveSkillId, effort, fromIndex });
      if (isNewThread) {
        heraldSendForKey(`herald-chat:${threadId}`, "/api/herald/chat/stream", body);
      } else {
        stream.send("/api/herald/chat/stream", body);
      }
      setEffort("");
    },
    [stream, projectId, chatId, effectiveSkillId, effort, applyChatId, openThreadParam, qc, setEffort, pendingTitleRef, ingressInsertedRef]
  );
}

// Turns view = settled merge of the server transcript with the live
// optimistic state. Adjusted during render (React derived-state pattern,
// keyed on transcript/stream identity) instead of an effect — the stream
// guards make pure derivation impossible, but the merge stays idempotent.
export function useSettledTurns(args: {
  transcriptData: { messages: unknown[] } | undefined;
  transcriptError: unknown;
  streaming: boolean;
  stream: Stream;
}) {
  const { transcriptData, transcriptError, streaming, stream } = args;
  const [turns, setTurns] = useState<ChatTurn[] | null>(null);
  const [syncedKey, setSyncedKey] = useState("");
  const syncKey = `${transcriptError ? "err" : "ok"}:${transcriptData ? transcriptData.messages.length : "-"}:${stream.status}:${stream.hasIngress}:${streaming}`;
  if (syncedKey !== syncKey) {
    setSyncedKey(syncKey);
    setTurns((prev) => {
      if (transcriptError) {
        if (stream.status === "error" && stream.hasIngress) return prev;
        return [];
      }
      if (!transcriptData) return prev;
      return settleTurns({
        prev,
        messages: transcriptData.messages,
        streaming,
        streamStatus: stream.status,
        hasIngress: stream.hasIngress,
      });
    });
  }
  return { turns, setTurns };
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
  useEffect(() => {
    if (!chatId) return;
    if (!isTerminalStreamStatus(stream.status)) return;
    const code = (transcriptError as { code?: string } | null)?.code;
    if (isThreadNotFoundCode(code)) {
      qc.cancelQueries({ queryKey: ["herald-chat", chatId] });
      qc.removeQueries({ queryKey: ["herald-chat", chatId] });
    } else {
      void qc.invalidateQueries({ queryKey: ["herald-chat", chatId] });
    }
    if (projectId) void qc.invalidateQueries({ queryKey: ["herald-chats", projectId] });
  }, [stream.status, chatId, projectId, qc, transcriptError]);
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
export function useTurnResend(args: {
  turns: ChatTurn[] | null;
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[] | null>>;
  rawMessages: unknown[];
  streaming: boolean;
  startStream: (message: string, fromIndex?: number) => void;
}) {
  const { turns, setTurns, rawMessages, streaming, startStream } = args;

  const handleEditSave = (target: ChatTurn, draft: string) => {
    const message = draft.trim();
    if (!message || streaming) return;
    const idx = resendIndex(rawMessages, "edit", target.rawIndex) ?? target.rawIndex;
    setTurns((prev) => truncateTurns(prev, target, message));
    startStream(message, idx);
  };

  // Regenerate exists ONLY on the last user turn: resends that message and
  // replaces the trailing assistant reply.
  const handleRegenerate = (target: ChatTurn) => {
    if (streaming) return;
    const idx = resendIndex(rawMessages, "regenerate") ?? target.rawIndex;
    setTurns((prev) => truncateTurns(prev, target));
    startStream(target.text, idx);
  };

  // Retry on a failed/stopped bubble resends ITS triggering user message
  // from that point without duplicating the failed turn.
  const handleRetryTurn = (assistantTurn: ChatTurn) => {
    if (streaming) return;
    const trigger = previousUserTurn(turns, assistantTurn);
    if (!trigger) return;
    const idx = resendIndex(rawMessages, "edit", trigger.rawIndex) ?? trigger.rawIndex;
    setTurns((prev) => truncateTurns(prev, trigger));
    startStream(trigger.text, idx);
  };

  return { handleEditSave, handleRegenerate, handleRetryTurn };
}

// Thread switching / history actions (History rows, New chat): deep-link
// via ?thread=; deleting the active thread resets to the fresh empty state.
// Mid-stream switch aborts the running stream — v1 accepted trade-off.
export function useChatThreadActions(args: {
  projectId: string | undefined;
  chatId: string;
  setChatId: (id: string) => void;
  streaming: boolean;
  abort: () => void;
  clearThreadParam: () => void;
  openThreadParam: (threadId: string) => void;
}) {
  const { projectId, chatId, setChatId, streaming, abort, clearThreadParam, openThreadParam } = args;
  const renameChat = useRenameHeraldChat(projectId);
  const deleteChat = useDeleteHeraldChat(projectId);
  const metaChat = useUpdateHeraldChatMeta(projectId);
  const handlePinToggle = useCallback((id: string, pinned: boolean) => void metaChat.mutateAsync({ chatId: id, pinned }), [metaChat]);
  const handleRename = useCallback((id: string, title: string) => renameChat.mutateAsync({ chatId: id, title }), [renameChat]);
  const handleDelete = useCallback(
    (id: string) =>
      deleteChat.mutateAsync({ chatId: id }).then(() => {
        if (id === chatId) {
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
      openThreadParam(id);
    },
    [streaming, abort, openThreadParam]
  );
  const startNewChat = useCallback(() => {
    selectThread(crypto.randomUUID());
  }, [selectThread]);
  return { handlePinToggle, handleRename, handleDelete, selectThread, startNewChat };
}

// Inline message editing state (user turns): one editor at a time, draft
// scoped to the edited position.
export function useChatEditing(args: {
  turns: ChatTurn[] | null;
  onEditSave: (target: ChatTurn, draft: string) => void;
}) {
  const { turns, onEditSave } = args;
  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
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
  const { data: settings, isLoading: settingsLoading } = useHeraldSettings(projectId);
  return { projects, projectFromList, projectError, project, resolved, projectId, settings, settingsLoading };
}

// Ref knowledge for stale-thread recovery: the persisted last-visited at
// mount and every chat id seen in a list snapshot. Effects only touch refs.
export function useThreadKnowledge(args: { projectId: string | undefined; listData: HeraldChatThreadSummary[] | undefined }) {
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
