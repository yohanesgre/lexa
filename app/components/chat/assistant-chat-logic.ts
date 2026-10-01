import type { QueryClient } from "@tanstack/react-query";
import { ASSISTANT_AGENT_ID, hasVisionCapability } from "../../lib/assistant-agent";
import type { LexaSkill } from "../../../shared/types";
import type { AssistantChatAttachment } from "../../../shared/assistant";
import type { ChatAttachmentRef } from "../../lib/assistant-image";
import { deriveChatTitle } from "../../../shared/assistant";
import type { AssistantChatThreadSummary } from "../../lib/api";
import { resolveRawUserIndex } from "../../lib/resendIndex";
import type { AssistantTimelineItem, AssistantToolChip } from "../../lib/use-assistant-stream";
import type { ApprovalChip } from "./AssistantApprovals";
import type { ActivityView, ChatTurn } from "./assistant-chat-utils";

// Pure decision helpers for the Assistant chat page. Stream/turn orchestration
// (effects, hooks) stays in AssistantChatPage / assistant-chat-session.ts.

// ── Thread list cache (assistant-chats) ──

export function sortThreads(threads: AssistantChatThreadSummary[]): AssistantChatThreadSummary[] {
  return threads.toSorted((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function threadEntry(chatId: string, message: string, now: string): AssistantChatThreadSummary {
  const derived = deriveChatTitle(message.trim());
  return {
    chatId,
    title: derived ? derived : null,
    pinned: false,
    snippet: null,
    createdAt: now,
    updatedAt: now,
  };
}

// First ingress on a NEW thread: seed every cached list (any ?q= variant)
// with the entry; existing lists only get their updatedAt touched, and
// search-filtered lists are left alone so ?q= results stay accurate.
export function touchThreadEntry(qc: QueryClient, projectId: string, entry: AssistantChatThreadSummary): void {
  const queries = qc.getQueriesData<AssistantChatThreadSummary[]>({ queryKey: ["assistant-chats", projectId] });
  if (queries.length === 0) {
    qc.setQueryData<AssistantChatThreadSummary[]>(["assistant-chats", projectId, null], sortThreads([entry]));
    return;
  }
  for (const [key] of queries) {
    qc.setQueryData<AssistantChatThreadSummary[]>(key, (old) => {
      if (!old) return old;
      const exists = old.some((t) => t.chatId === entry.chatId);
      if (exists) return sortThreads(old.map((t) => (t.chatId === entry.chatId ? { ...t, updatedAt: entry.updatedAt } : t)));
      const q = (key[2] as string | null) ?? null;
      if (q !== null) return old;
      return sortThreads([...old, entry]);
    });
  }
}

// Optimistic seed for a just-created thread: only the unfiltered list.
export function insertNewThread(qc: QueryClient, projectId: string, threadId: string, entry: AssistantChatThreadSummary): void {
  qc.setQueryData<AssistantChatThreadSummary[]>(["assistant-chats", projectId, null], (old) => {
    if (!old) return sortThreads([entry]);
    if (old.some((t) => t.chatId === threadId)) return old;
    return sortThreads([...old, entry]);
  });
}

// ── Stream send ──

export function chatStreamBody(args: {
  projectId: string | undefined;
  chatId: string;
  message: string;
  effort: string;
  attachments?: ChatAttachmentRef[] | undefined;
  fromIndex?: number | undefined;
}) {
  const attachments: AssistantChatAttachment[] = (args.attachments ?? []).map((a) => ({
    storageKey: a.storageKey,
    mimeType: a.mimeType,
    name: a.name,
  }));
  return {
    projectId: args.projectId,
    chatId: args.chatId,
    message: args.message,
    attachments,
    ...(args.effort ? { reasoningEffort: args.effort } : {}),
    ...(args.fromIndex !== undefined ? { fromIndex: args.fromIndex } : {}),
  };
}

// ── Turn list transforms (setTurns updaters) ──

export function ephemeralUserTurn(message: string, attachments: ChatAttachmentRef[], rawIndex = -1): ChatTurn {
  return {
    role: "user",
    text: message,
    imageCount: attachments.filter((a) => a.mimeType.startsWith("image/")).length,
    rawIndex,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function appendEphemeralUserTurn(prev: ChatTurn[] | null, message: string, attachments: ChatAttachmentRef[]): ChatTurn[] {
  return [...(prev ?? []), ephemeralUserTurn(message, attachments)];
}

// Keep turns up to & including `target` (optionally rewriting its text) —
// the optimistic view of edit/regenerate/retry until the terminal-state
// refetch replaces it with server truth.
export function truncateTurns(prev: ChatTurn[] | null, target: ChatTurn, replaceText?: string): ChatTurn[] {
  const arr = prev ?? [];
  const pos = arr.indexOf(target);
  if (pos < 0) return arr;
  const kept = arr.slice(0, pos + 1);
  return replaceText !== undefined ? kept.map((t, i) => (i === pos ? { ...t, text: replaceText } : t)) : kept;
}

// Retry on a failed/stopped bubble resends ITS triggering user message —
// the nearest user turn before the failed assistant turn.
export function previousUserTurn(turns: ChatTurn[] | null, assistantTurn: ChatTurn): ChatTurn | null {
  const arr = turns ?? [];
  const pos = arr.indexOf(assistantTurn);
  for (let i = pos - 1; i >= 0; i--) {
    if (arr[i]!.role === "user") return arr[i]!;
  }
  return null;
}

export function lastUserIndex(turns: ChatTurn[] | null): number {
  const arr = turns ?? [];
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i]!.role === "user") return i;
  return -1;
}

// Resolve an edit/regenerate/retry request to a RAW user-message index. The
// display turn is only a locator: the server truncates its OWN raw array, so
// the index must come from `rawMessages`. An optimistic display turn
// (rawIndex -1) can never be the target by itself — it is mapped back to the
// nearest raw user turn with the same text. The text fallback is floored at the
// raw position just past the turn's nearest preceding sibling with a known raw
// index: without the floor, stale `rawMessages` would map the optimistic turn
// onto an OLDER identical prompt and the server would truncate the thread to
// that point, dropping later prompts. Returns null when unmappable; callers
// surface a visible error instead of a silent no-op.
//
// - edit/regenerate: `target` is the display user turn (the edited bubble / the
//   last user turn);
// - retry: `target` is the failed/stopped assistant turn — the trigger is the
//   nearest preceding user turn.
export function resolveResendTarget(args: {
  turns: ChatTurn[] | null;
  target: ChatTurn;
  rawMessages: readonly unknown[];
  mode: "edit" | "regenerate" | "retry";
}): { turn: ChatTurn; index: number } | null {
  const turn = args.mode === "retry" ? previousUserTurn(args.turns, args.target) : args.target;
  if (!turn || turn.role !== "user") return null;
  const turns = args.turns ?? [];
  const pos = turns.indexOf(turn);
  let floor = 0;
  for (let i = pos; i >= 0; i--) {
    const rawIndex = turns[i]?.rawIndex ?? -1;
    if (rawIndex >= 0) {
      floor = rawIndex + 1;
      break;
    }
  }
  const index = resolveRawUserIndex(args.rawMessages, turn, floor);
  return index === null ? null : { turn, index };
}

// ── Write approvals ──

export function applyChipPatch(
  prev: ChatTurn[] | null,
  approvalId: string,
  patch: Partial<ApprovalChip> & { state: ApprovalChip["state"] }
): ChatTurn[] {
  return (prev ?? []).map((t) => {
    if (!t.batch || !t.batch.chips.some((c) => c.approvalId === approvalId)) return t;
    return { ...t, batch: { ...t.batch, chips: t.batch.chips.map((c) => (c.approvalId === approvalId ? { ...c, ...patch } : c)) } };
  });
}

export function pendingChipTargets(chips: ApprovalChip[]): ApprovalChip[] {
  return chips.filter((c) => c.state === "pending");
}

// One decision = one POST keyed by approvalId; the response's status is
// authoritative for that chip only. Server-side 409s flip the chip to their
// terminal state instead of surfacing as toasts (null → toast path).
export function chipStateFromError(err: Error & { code?: string | undefined; details?: unknown }): ApprovalChip["state"] | null {
  if (err.code === "APPROVAL_EXPIRED") return "expired";
  // The decision row is gone (deleted/swept): the chip can never be decided,
  // so retire it instead of leaving it pending and locking the composer.
  if (err.code === "APPROVAL_NOT_FOUND") return "expired";
  if (err.code === "APPROVAL_ALREADY_DECIDED") {
    const prev = (err.details as { status?: string } | undefined)?.status;
    return prev === "approved" ? "approved" : prev === "rejected" ? "rejected" : "expired";
  }
  return null;
}

// ── Freeze (suspended / error terminal frames) ──

export function pendingChipsOf(pending: ReadonlyArray<Omit<ApprovalChip, "state"> & { batchId: string }>, batchId: string): ApprovalChip[] {
  const chips: ApprovalChip[] = [];
  for (const p of pending) {
    if (p.batchId === batchId) chips.push({ ...p, state: "pending" as const });
  }
  return chips;
}

// Post-stream activity snapshot for a frozen frame. "suspended" freezes on
// any reasoning/tool signal; "error" also counts bare timeline items.
export function frozenActivity(
  stream: { items: AssistantTimelineItem[]; tools: AssistantToolChip[]; reasoningMs: number | null; reasoningText: string },
  mode: "suspended" | "error"
): ActivityView | undefined {
  const hasSignal =
    mode === "suspended"
      ? stream.reasoningText || stream.tools.length > 0 || stream.reasoningMs !== null
      : stream.items.length > 0 || stream.tools.length > 0 || stream.reasoningMs !== null || stream.reasoningText;
  return hasSignal ? { items: stream.items, tools: stream.tools, reasoningMs: stream.reasoningMs } : undefined;
}

// The suspended frame freezes into a fresh assistant turn (audit trail);
// chips ride along when the batch carried payloads, else the marker-only
// suspension renders the waiting indicator after reload.
export function suspendTurnFrame(args: {
  batchId: string;
  chips: ApprovalChip[];
  text: string;
  activity: ActivityView | undefined;
}): ChatTurn {
  const { batchId, chips, text, activity } = args;
  return {
    role: "assistant",
    text,
    imageCount: 0,
    rawIndex: -1,
    ...(activity ? { activity } : {}),
    ...(chips.length > 0 ? { batch: { batchId, chips } } : { suspendedBatchId: batchId }),
  };
}

// Error frames freeze/merge into the trailing assistant turn: same-code
// errors are idempotent (no dup), a different error on an errored tail
// overwrites it, otherwise a fresh failed turn appends.
export function nextTurnsAfterStreamError(
  prev: ChatTurn[] | null,
  args: { code: string; text: string; error: { code: string; message: string }; activity: ActivityView | undefined }
): ChatTurn[] {
  const arr = prev ?? [];
  const last = arr[arr.length - 1];
  if (last?.role === "assistant" && last.error?.code === args.code) return arr;
  if (last?.role === "assistant" && last.error) {
    return arr.map((t, i) => (i === arr.length - 1 ? { ...t, text: args.text || t.text, error: args.error, ...(args.activity ? { activity: args.activity } : {}) } : t));
  }
  return [...arr, { role: "assistant", text: args.text, imageCount: 0, rawIndex: -1, error: args.error, ...(args.activity ? { activity: args.activity } : {}) }];
}

// First frozen batch (scanning from the tail) whose chips have ALL reached
// a terminal state and that has not been resumed yet.
export function resumableBatchId(turns: ChatTurn[] | null, resumed: Set<string>): string | null {
  for (let i = (turns ?? []).length - 1; i >= 0; i--) {
    const b = turns?.[i]!.batch;
    if (!b || resumed.has(b.batchId)) continue;
    if (b.chips.some((c) => c.state === "pending")) return null;
    return b.batchId;
  }
  return null;
}

// ── Composer lock / tally ──

// ── Thread resolution ( ?thread= deep link | in-session selection ) ──

// Returns the chat id to apply, or null when the current selection stands. An
// explicit ?thread= deep link always wins. With no deep link, the last active
// thread (`lexa-chat-last:<projectId>`) is restored so a run that survived a
// navigation re-attaches (LX-8); the already-applied in-session selection is
// never clobbered. Deleting the active thread clears the memory first, so the
// restore falls through to the fresh landing. An unmapped/empty memory is the
// new-chat landing.
export function resolveChatId(args: {
  projectId: string | undefined;
  thread: string | undefined;
  currentChatId: string;
  lastVisited?: string | null;
}): string | null {
  if (!args.projectId) return null;
  if (args.thread) return args.thread === args.currentChatId ? null : args.thread;
  const last = args.lastVisited ?? null;
  if (last && last !== args.currentChatId) return last;
  return null;
}

// ── Stale-thread recovery predicates ──

export type ThreadMeta = { thread: string | undefined; knownChatIds: Set<string>; initialLast: string | null };

// ?thread= deep link pointing at a thread we have never seen (not in any
// list snapshot, not the persisted last-visited) → it is brand-new; keep it.
export function isUntrackedDeepLink(chatId: string, meta: ThreadMeta): boolean {
  return meta.thread === chatId && !meta.knownChatIds.has(chatId) && meta.initialLast !== chatId;
}

export function isTerminalStreamStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted" || status === "suspended";
}

export function isThreadNotFoundCode(code: string | undefined): boolean {
  return code === "ASSISTANT_THREAD_NOT_FOUND" || code === "NOT_FOUND";
}

// Terminal stream frame → transcript action. A not-found that predates ANY
// ingress means the thread never existed server-side (drop the dead query). The
// same code AFTER ingress means the fresh UUID's write landed and the thread now
// exists — the 404 is stale, so the persisted turns must be refetched instead of
// dropping the query. Every other terminal path refetches/invalidates.
export type TerminalTranscriptAction = "drop" | "refetch";

export function terminalTranscriptAction(code: string | undefined, hasIngress: boolean): TerminalTranscriptAction {
  if (isThreadNotFoundCode(code) && !hasIngress) return "drop";
  return "refetch";
}

export function isThreadNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (isThreadNotFoundCode(code)) return true;
  return (error as Error | null)?.message?.includes("404") ?? false;
}

// Transcript 404 on a thread that cannot be a fresh deep link → stale
// selection: drop the cache entry, clear ?thread=, land on the fresh chat.
export function staleThreadNeedsRecovery(args: {
  projectId: string | undefined;
  chatId: string;
  transcriptLoading: boolean;
  transcriptError: unknown;
  hasIngress: boolean;
  streaming: boolean;
  listData: AssistantChatThreadSummary[] | undefined;
  meta: ThreadMeta;
}): boolean {
  const { projectId, chatId, transcriptLoading, transcriptError, hasIngress, streaming, listData, meta } = args;
  if (!projectId || !chatId) return false;
  if (transcriptLoading) return false;
  if (!transcriptError) return false;
  if (!isThreadNotFound(transcriptError)) return false;
  if (hasIngress || streaming) return false;
  if (!listData) return false;
  if (isUntrackedDeepLink(chatId, meta)) return false;
  return true;
}

// ?thread= that never appears in any list snapshot while the transcript 404s
// (and the stream is idle) → dead deep link, land on the fresh chat. A transient
// read failure is not evidence of a dead link and must not evict the thread.
export function orphanThreadNeedsRecovery(args: {
  projectId: string | undefined;
  chatId: string;
  transcriptError: unknown;
  hasIngress: boolean;
  streaming: boolean;
  listLoading: boolean;
  listData: AssistantChatThreadSummary[] | undefined;
  meta: ThreadMeta;
}): boolean {
  const { projectId, chatId, transcriptError, hasIngress, streaming, listLoading, listData, meta } = args;
  if (!projectId || !chatId || !listData || listLoading) return false;
  if (isUntrackedDeepLink(chatId, meta)) return false;
  if (!isThreadNotFound(transcriptError)) return false;
  return !!meta.thread && listData.length > 0 && !listData.some((t) => t.chatId === chatId) && !hasIngress && !streaming;
}

// Post-stream activity summary (done only) — attached to the trailing
// assistant turn while this tab's session still holds it.
export function streamDoneActivity(stream: {
  status: string;
  items: AssistantTimelineItem[];
  tools: AssistantToolChip[];
  reasoningMs: number | null;
  reasoningText: string;
}): ActivityView | undefined {
  if (stream.status !== "done") return undefined;
  if (!stream.reasoningText && stream.tools.length === 0) return undefined;
  return { items: stream.items, tools: stream.tools, reasoningMs: stream.reasoningMs };
}

// Recovery execution shared by both stale-thread predicates: drop the dead
// transcript cache, evict the dead id from every cached list variant, clear the
// ?thread= param and land on the fresh empty chat. The destination is ALWAYS
// the fresh landing — a settled 404 for a thread that is not in the list
// snapshot must never jump to a list head, or a reload re-opens the
// latest/previous thread.
export function dropUnknownThread(args: {
  qc: QueryClient;
  projectId: string | undefined;
  chatId: string;
  setChatId: (id: string) => void;
  clearThreadParam: () => void;
  clearParam: boolean;
}): void {
  const { qc, projectId, chatId, setChatId, clearThreadParam, clearParam } = args;
  qc.cancelQueries({ queryKey: ["assistant-chat", chatId] });
  qc.removeQueries({ queryKey: ["assistant-chat", chatId] });
  // Evict the dead id from every cached list variant so no list render can
  // re-open it.
  qc.setQueriesData<AssistantChatThreadSummary[]>({ queryKey: ["assistant-chats", projectId] }, (old) =>
    old ? old.filter((t) => t.chatId !== chatId) : old
  );
  try { window.localStorage.removeItem(`lexa-chat-last:${projectId}`); } catch {}
  if (clearParam) clearThreadParam();
  setChatId("");
}

// ── Chat skill selection (mirrors the panel's Assistant-junction filter) ──

export function chatSkillsOf(agents: Array<{ id: string; skillIds?: string[] }>, skills: LexaSkill[]): LexaSkill[] {
  const assistantSkillIds = new Set(agents.find((a) => a.id === ASSISTANT_AGENT_ID)?.skillIds ?? []);
  return skills.filter((s) => assistantSkillIds.has(s.id));
}

// ── Derived page flags (pure) ──

export function chatPageFlags(args: {
  settings: Parameters<typeof hasVisionCapability>[0];
  settingsLoading: boolean;
  turns: ChatTurn[] | null;
  streamStatus: string;
  streamErrorCode: string | undefined;
  streamPendingCount: number;
}) {
  const { settings, settingsLoading, turns, streamStatus, streamErrorCode, streamPendingCount } = args;
  // Vision resolution mirrors task create: primary inline parts or a
  // configured vision model; without either, attach is disabled with a
  // tooltip pointing at Project Settings → Assistant vision.
  const attachDisabled = !settingsLoading && settings !== null && !hasVisionCapability(settings);
  const busy409 = streamStatus === "error" && streamErrorCode === "ASSISTANT_TASK_ACTIVE";
  // Composer lock while any approval chip is pending (same rule as
  // streaming) — includes the marker-only reload case (no chip payloads).
  const batchChips = (turns ?? []).flatMap((t) => t.batch?.chips ?? []);
  const pendingCount = batchChips.filter((c) => c.state === "pending").length;
  const hasSuspendedMarker = (turns ?? []).some((t) => !!t.suspendedBatchId);
  const suspendedLock = pendingCount > 0 || hasSuspendedMarker || streamStatus === "suspended";
  return {
    busy409,
    attachDisabled,
    suspendedLock,
    // The suspended status line names the pending count; a marker-only reload
    // (no chip payloads) falls back to the stream's own pending count.
    suspendPendingCount: batchChips.length > 0 ? pendingCount : streamPendingCount,
  };
}
