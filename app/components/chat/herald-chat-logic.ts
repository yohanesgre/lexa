import type { QueryClient } from "@tanstack/react-query";
import { ENGINE_AGENT_IDS, hasVisionCapability } from "../../lib/use-hearth-engine";
import type { LexaSkill } from "../../../shared/types";
import { deriveChatTitle } from "../../../shared/herald";
import type { HeraldChatThreadSummary } from "../../lib/api";
import type { HeraldTimelineItem, HeraldToolChip } from "../../lib/use-herald-stream";
import type { ApprovalChip } from "./HeraldApprovals";
import type { ActivityView, ChatTurn } from "./herald-chat-utils";

// Pure decision helpers for the Herald chat page. Stream/turn orchestration
// (effects, hooks) stays in HeraldChatPage / herald-chat-session.ts.

// ── Thread list cache (herald-chats) ──

export function sortThreads(threads: HeraldChatThreadSummary[]): HeraldChatThreadSummary[] {
  return threads.toSorted((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function threadEntry(chatId: string, message: string, now: string): HeraldChatThreadSummary {
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
export function touchThreadEntry(qc: QueryClient, projectId: string, entry: HeraldChatThreadSummary): void {
  const queries = qc.getQueriesData<HeraldChatThreadSummary[]>({ queryKey: ["herald-chats", projectId] });
  if (queries.length === 0) {
    qc.setQueryData<HeraldChatThreadSummary[]>(["herald-chats", projectId, null], sortThreads([entry]));
    return;
  }
  for (const [key] of queries) {
    qc.setQueryData<HeraldChatThreadSummary[]>(key, (old) => {
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
export function insertNewThread(qc: QueryClient, projectId: string, threadId: string, entry: HeraldChatThreadSummary): void {
  qc.setQueryData<HeraldChatThreadSummary[]>(["herald-chats", projectId, null], (old) => {
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
  skillId: string;
  effort: string;
  fromIndex?: number | undefined;
}) {
  return {
    projectId: args.projectId,
    chatId: args.chatId,
    message: args.message,
    skillId: args.skillId || undefined,
    attachments: [],
    ...(args.effort ? { reasoningEffort: args.effort } : {}),
    ...(args.fromIndex !== undefined ? { fromIndex: args.fromIndex } : {}),
  };
}

// ── Turn list transforms (setTurns updaters) ──

export function appendEphemeralUserTurn(prev: ChatTurn[] | null, message: string, imageCount: number): ChatTurn[] {
  return [...(prev ?? []), { role: "user", text: message, imageCount, rawIndex: -1 }];
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
  stream: { items: HeraldTimelineItem[]; tools: HeraldToolChip[]; reasoningMs: number | null; reasoningText: string },
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

export function suspendTallyText(total: number, pending: number, streamPending: number): string {
  const effectiveTotal = total > 0 ? total : streamPending;
  const effectivePending = total > 0 ? pending : streamPending;
  if (effectiveTotal === 0) return "";
  return effectivePending === effectiveTotal ? `${effectivePending} pending` : `${effectivePending} of ${effectiveTotal} pending`;
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
  return code === "HERALD_THREAD_NOT_FOUND" || code === "NOT_FOUND";
}

export function isThreadNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (isThreadNotFoundCode(code)) return true;
  return (error as Error | null)?.message?.includes("404") ?? false;
}

// Transcript 404 on a thread that cannot be a fresh deep link → stale
// selection: drop the cache entry, clear ?thread=, fall back to list head.
export function staleThreadNeedsRecovery(args: {
  projectId: string | undefined;
  chatId: string;
  transcriptLoading: boolean;
  transcriptError: unknown;
  hasIngress: boolean;
  streaming: boolean;
  listData: HeraldChatThreadSummary[] | undefined;
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

// ?thread= that never appears in any list snapshot while the transcript
// errors (and the stream is idle) → dead deep link, recover to list head.
export function orphanThreadNeedsRecovery(args: {
  projectId: string | undefined;
  chatId: string;
  transcriptError: unknown;
  hasIngress: boolean;
  streaming: boolean;
  listLoading: boolean;
  listData: HeraldChatThreadSummary[] | undefined;
  meta: ThreadMeta;
}): boolean {
  const { projectId, chatId, transcriptError, hasIngress, streaming, listLoading, listData, meta } = args;
  if (!projectId || !chatId || !listData || listLoading) return false;
  if (isUntrackedDeepLink(chatId, meta)) return false;
  return !!meta.thread && listData.length > 0 && !listData.some((t) => t.chatId === chatId) && !hasIngress && !streaming && !!transcriptError;
}

// Post-stream activity summary (done only) — attached to the trailing
// assistant turn while this tab's session still holds it.
export function streamDoneActivity(stream: {
  status: string;
  items: HeraldTimelineItem[];
  tools: HeraldToolChip[];
  reasoningMs: number | null;
  reasoningText: string;
}): ActivityView | undefined {
  if (stream.status !== "done") return undefined;
  if (!stream.reasoningText && stream.tools.length === 0) return undefined;
  return { items: stream.items, tools: stream.tools, reasoningMs: stream.reasoningMs };
}

// Recovery execution shared by both stale-thread predicates: drop the dead
// transcript cache, clear ?thread=, fall back to the list head (or the
// fresh empty state when the list has none).
export function recoverStaleThread(args: {
  qc: QueryClient;
  projectId: string | undefined;
  chatId: string;
  listData: HeraldChatThreadSummary[] | undefined;
  applyChatId: (id: string) => void;
  setChatId: (id: string) => void;
  clearThreadParam: () => void;
  clearParam: boolean;
}): void {
  const { qc, projectId, chatId, listData, applyChatId, setChatId, clearThreadParam, clearParam } = args;
  qc.cancelQueries({ queryKey: ["herald-chat", chatId] });
  qc.removeQueries({ queryKey: ["herald-chat", chatId] });
  try { window.localStorage.removeItem(`lexa-chat-last:${projectId}`); } catch {}
  if (clearParam) clearThreadParam();
  const head = listData?.[0]?.chatId;
  if (head && head !== chatId) applyChatId(head);
  else setChatId("");
}

// ── Chat skill selection (mirrors the panel's Herald-junction filter) ──

export function chatSkillsOf(
  agents: Array<{ id: string; skillIds?: string[] }>,
  skills: LexaSkill[],
  skillId: string
): { skills: LexaSkill[]; effectiveSkillId: string; skillName: string | undefined } {
  const heraldSkillIds = new Set(agents.find((a) => a.id === ENGINE_AGENT_IDS.herald)?.skillIds ?? []);
  const filtered = skills.filter((s) => heraldSkillIds.has(s.id));
  const effectiveSkillId = heraldSkillIds.has(skillId) ? skillId : "";
  return { skills: filtered, effectiveSkillId, skillName: filtered.find((s) => s.id === effectiveSkillId)?.name };
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
  // Engine gate (herald-chat.html): chat ALWAYS runs the herald lane — under
  // a blacksmith project default every stream fails up front, so the banner
  // renders before any attempt.
  const engineGate = settings?.engine === "blacksmith";
  // Vision resolution mirrors task create: primary inline parts or a
  // configured vision model; without either, attach is disabled with a
  // tooltip pointing at Project Settings → Herald vision.
  const attachDisabled = !settingsLoading && settings !== null && !hasVisionCapability(settings);
  const busy409 = streamStatus === "error" && streamErrorCode === "HERALD_TASK_ACTIVE";
  // Composer lock while any approval chip is pending (same rule as
  // streaming) — includes the marker-only reload case (no chip payloads).
  const batchChips = (turns ?? []).flatMap((t) => t.batch?.chips ?? []);
  const pendingCount = batchChips.filter((c) => c.state === "pending").length;
  const hasSuspendedMarker = (turns ?? []).some((t) => !!t.suspendedBatchId);
  const suspendedLock = pendingCount > 0 || hasSuspendedMarker || streamStatus === "suspended";
  return {
    engineGate,
    busy409,
    attachDisabled,
    suspendedLock,
    suspendTally: suspendTallyText(batchChips.length, pendingCount, streamPendingCount),
  };
}
