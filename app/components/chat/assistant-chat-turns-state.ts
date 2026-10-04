import { renderTranscript } from "./assistant-chat-utils";
import type { ChatTurn } from "./assistant-chat-utils";
import type { ApprovalChip } from "./AssistantApprovals";

// Turn-settle policy for the Assistant chat transcript (pure): merge the
// server transcript with the live optimistic view. Ephemeral user turns
// (rawIndex -1) ride along while the stream is live so a send is never
// visually dropped; a fresh shorter server list during an active stream is
// ignored; a failed turn is kept while the stream still holds ingress.

const TERMINAL_CHIP_STATES: ReadonlySet<ApprovalChip["state"]> = new Set([
  "approved",
  "rejected",
  "expired",
  "failed",
]);

// Terminal chip decisions sourced from a turn list, keyed by approvalId.
function terminalDecisions(turns: ChatTurn[] | null): Map<string, ApprovalChip["state"]> {
  const decided = new Map<string, ApprovalChip["state"]>();
  for (const t of turns ?? []) {
    for (const c of t.batch?.chips ?? []) {
      if (TERMINAL_CHIP_STATES.has(c.state)) decided.set(c.approvalId, c.state);
    }
  }
  return decided;
}

// Overlay terminal decisions onto a turn list by approvalId. Only terminal
// states propagate — an approval still pending or absent in the source keeps
// the target's state. Never mutates the input; returns the target identity
// when nothing changed.
function overlayDecisions(turns: ChatTurn[], decided: Map<string, ApprovalChip["state"]>): ChatTurn[] {
  if (decided.size === 0) return turns;
  let touched = false;
  const out = turns.map((t) => {
    if (!t.batch) return t;
    let chipTouched = false;
    const chips = t.batch.chips.map((c) => {
      const state = decided.get(c.approvalId);
      if (state === undefined || state === c.state) return c;
      chipTouched = true;
      return { ...c, state };
    });
    if (!chipTouched) return t;
    touched = true;
    return { ...t, batch: { ...t.batch, chips } };
  });
  return touched ? out : turns;
}

// A transcript rebuild loses this session's chip decisions: a persisted
// approval whose `status` was never reconciled maps back to pending
// (chipFromPendingApproval), re-arming a chip we already decided and re-POSTing
// it (409 burst). Overlay KNOWN terminal decisions from the optimistic view by
// approvalId. Never mutates the input.
export function carryKnownDecisions(prev: ChatTurn[] | null, turns: ChatTurn[]): ChatTurn[] {
  return overlayDecisions(turns, terminalDecisions(prev));
}

// A8: a terminal transcript read that is SHORTER than the settled local view is
// a transient server regression — a DO read still scoped to the current run
// drops the previously persisted turns. Never replace the settled history with
// it: keep prev's earlier turns and splice in the server's own tail (the
// current run's messages, so the new reply survives). The run's prompt is
// located by the last user turn in prev carrying the server tail's first user
// text. An EMPTY server list is not reconciled — a genuinely cleared transcript
// keeps the existing reset semantics (callers pass prev=null on a thread swap).
function reconcileShorterTranscript(prev: ChatTurn[], serverTurns: ChatTurn[]): ChatTurn[] {
  const firstUser = serverTurns.findIndex((t) => t.role === "user");
  // A tail with no user turn to anchor on (an assistant-only read): keep the
  // settled history and append what the server knows.
  if (firstUser < 0) return [...prev, ...serverTurns];
  const prompt = serverTurns[firstUser]!;
  let cut = -1;
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i]!.role === "user" && prev[i]!.text === prompt.text) {
      cut = i;
      break;
    }
  }
  // Cannot locate the run's prompt in prev (its text was rewritten, or the
  // optimistic turn is gone): keep the settled history and append the server
  // tail rather than discarding it.
  if (cut < 0) return [...prev, ...serverTurns];
  return [...prev.slice(0, cut), ...serverTurns];
}

export function settleTurns(args: {
  prev: ChatTurn[] | null;
  messages: unknown[];
  streaming: boolean;
  streamStatus: string;
  hasIngress: boolean;
}): ChatTurn[] | null {
  const { prev, messages, streaming, streamStatus, hasIngress } = args;
  const serverTurns = carryKnownDecisions(prev, renderTranscript(messages));
  const liveApproval = (prev ?? []).some(
    (t) => t.batch?.chips.some((c) => c.state === "pending") || t.suspendedBatchId
  );
  if (liveApproval) {
    // The optimistic view must not mask a decision the server already made: a
    // cached pre-decision marker refetched with reconciled terminal statuses
    // (another tab / this session before remount) must flip its chips terminal
    // instead of staying pending. Overlay only the server's terminal states
    // over prev — every still-pending chip and the suspension structure stay
    // optimistic.
    return overlayDecisions(prev ?? [], terminalDecisions(serverTurns));
  }
  // A8: at a terminal frame a shorter server read must not erase the settled
  // history. Reconcile (keep earlier turns + merge the server tail) instead of
  // replacing; active streams keep the existing live-merge below.
  if (prev && !streaming && streamStatus !== "connecting" && serverTurns.length > 0 && serverTurns.length < prev.length) {
    return reconcileShorterTranscript(prev, serverTurns);
  }
  const ephemeralUsers = (prev ?? []).filter((t) => t.role === "user" && t.rawIndex === -1);
  if (ephemeralUsers.length > 0 && (streaming || hasIngress || streamStatus === "suspended")) {
    const toAdd = ephemeralUsers.filter((e) => !serverTurns.some((s) => s.role === "user" && s.text === e.text));
    if (toAdd.length > 0) return [...serverTurns, ...toAdd];
  }
  if ((streaming || streamStatus === "connecting") && prev && prev.length < serverTurns.length) {
    return prev;
  }
  if ((streamStatus === "error" || streaming) && hasIngress) {
    const hasFailed = serverTurns.some((t) => !!t.error);
    if (!hasFailed && (prev ?? []).length > serverTurns.length) return prev;
  }
  return serverTurns;
}
