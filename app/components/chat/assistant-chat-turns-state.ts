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

// Turn list + the raw transcript snapshot its rawIndex values point into. The
// snapshot is NOT always the live `messages`: after a reconcile the kept turns
// retain positions from the raw read they were derived from, so resend targets
// must resolve against the merged snapshot, not the shorter live read.
export interface TurnSettlement {
  turns: ChatTurn[];
  raw: unknown[];
}

function sameTurn(a: ChatTurn, b: ChatTurn): boolean {
  return a.role === b.role && a.text === b.text;
}

function lastUserIndex(prev: ChatTurn[]): number {
  for (let i = prev.length - 1; i >= 0; i--) if (prev[i]!.role === "user") return i;
  return -1;
}

// Earliest contiguous block of `serverTurns` inside `prev` (role+text), or -1.
// Used to recognize a stale full read whose messages already exist in the
// settled view — splicing at the newest duplicate prompt would otherwise
// resurrect a duplicated prefix.
function blockStart(prev: ChatTurn[], serverTurns: ChatTurn[]): number {
  const n = serverTurns.length;
  if (n === 0 || n > prev.length) return -1;
  for (let a = 0; a + n <= prev.length; a++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!sameTurn(prev[a + j]!, serverTurns[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return a;
  }
  return -1;
}

// Shift a server tail's rawIndex values into a merged raw snapshot
// (prevRaw ++ messages) so kept earlier turns and the tail stay resolvable in
// one index space.
function shiftRaw(turns: ChatTurn[], offset: number): ChatTurn[] {
  if (offset === 0) return turns;
  return turns.map((t) => (t.rawIndex < 0 ? t : { ...t, rawIndex: t.rawIndex + offset }));
}

const turnKey = (t: ChatTurn) => `${t.role}\u0000${t.text}`;

// A8: a terminal transcript read that is SHORTER than the settled local view is
// a transient server regression — a DO read still scoped to the current run
// drops the previously persisted turns. Never replace the settled history with
// it: keep prev's earlier turns and splice in the server's own tail (the
// current run's messages, so the new reply survives). The run's prompt is
// prev's LAST user turn; the server tail must start with that same text. An
// EMPTY server list is not reconciled — a genuinely cleared transcript keeps
// the existing reset semantics (callers pass prev=null on a thread swap).
//
// Returns the merged raw snapshot alongside the turns so resend targets resolve
// against the array the kept turns were derived from (M1). A tail that already
// exists earlier in prev is a stale full read (duplicate prompt text): replace
// from the block's own start instead of splicing at the newest duplicate (N1).
function reconcileShorterTranscript(
  prev: ChatTurn[],
  serverTurns: ChatTurn[],
  prevRaw: unknown[],
  messages: unknown[]
): TurnSettlement {
  const firstUser = serverTurns.findIndex((t) => t.role === "user");
  const lastUser = lastUserIndex(prev);
  const anchored = firstUser >= 0 && lastUser >= 0 && prev[lastUser]!.text === serverTurns[firstUser]!.text;
  const offset = prevRaw.length;
  if (!anchored) {
    // No run prompt to anchor on (assistant-only read, or prev's last user text
    // was rewritten): keep the settled history and append only the tail turns
    // it does not already hold.
    const existing = new Set(prev.map(turnKey));
    const add = shiftRaw(serverTurns, offset).filter((t) => !existing.has(turnKey(t)));
    return { turns: add.length > 0 ? [...prev, ...add] : prev, raw: [...prevRaw, ...messages] };
  }
  const start = blockStart(prev, serverTurns);
  if (start >= 0 && start < lastUser) {
    // The tail already exists earlier in prev — a stale full read carrying a
    // duplicate prompt text. Replace from its own start; anchoring at prev's
    // last user turn would duplicate the prefix.
    return { turns: [...prev.slice(0, start), ...serverTurns], raw: messages };
  }
  // Run-scoped tail: keep the settled prefix up to the run prompt, splice the
  // server's tail (shifted into the merged raw snapshot), then re-append any
  // frozen error turn from prev's suffix the server read replaced — a terminal
  // error read is run-scoped and does not carry the client's failure bubble (M2).
  const merged = [...prev.slice(0, lastUser), ...shiftRaw(serverTurns, offset)];
  const present = new Set(merged.map(turnKey));
  const reattach = prev.slice(lastUser + 1).filter((t) => !!t.error && !present.has(turnKey(t)));
  return { turns: [...merged, ...reattach], raw: [...prevRaw, ...messages] };
}

export function settleTurnsWithRaw(args: {
  prev: ChatTurn[] | null;
  prevRaw: unknown[];
  messages: unknown[];
  streaming: boolean;
  streamStatus: string;
  hasIngress: boolean;
}): TurnSettlement {
  const { prev, prevRaw, messages, streaming, streamStatus, hasIngress } = args;
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
    return { turns: overlayDecisions(prev ?? [], terminalDecisions(serverTurns)), raw: prevRaw };
  }
  // A8/M2: at a terminal frame a shorter server read must not erase the settled
  // history — but reconcile ONLY when the read actually covers the current run.
  // Its first user turn must be prev's last user turn AND prev must hold only
  // optimistic turns after it; otherwise the read is an older/partial prefix
  // (e.g. one that predates the just-sent user turn) and must fall through to
  // the error/ephemeral preservation branches below instead of erasing them.
  if (prev && !streaming && streamStatus !== "connecting" && serverTurns.length > 0 && serverTurns.length < prev.length) {
    const firstUser = serverTurns.findIndex((t) => t.role === "user");
    const lastUser = lastUserIndex(prev);
    const suffixOptimistic = prev.slice(lastUser + 1).every((t) => t.rawIndex < 0);
    const coversRun = firstUser < 0 || (prev[lastUser]!.text === serverTurns[firstUser]!.text && suffixOptimistic);
    if (coversRun) return reconcileShorterTranscript(prev, serverTurns, prevRaw, messages);
  }
  const ephemeralUsers = (prev ?? []).filter((t) => t.role === "user" && t.rawIndex === -1);
  if (ephemeralUsers.length > 0 && (streaming || hasIngress || streamStatus === "suspended")) {
    const toAdd = ephemeralUsers.filter((e) => !serverTurns.some((s) => s.role === "user" && s.text === e.text));
    if (toAdd.length > 0) return { turns: [...serverTurns, ...toAdd], raw: messages };
  }
  if ((streaming || streamStatus === "connecting") && prev && prev.length < serverTurns.length) {
    return { turns: prev, raw: prevRaw };
  }
  if ((streamStatus === "error" || streaming) && hasIngress) {
    const hasFailed = serverTurns.some((t) => !!t.error);
    if (prev && !hasFailed && prev.length > serverTurns.length) return { turns: prev, raw: prevRaw };
  }
  return { turns: serverTurns, raw: messages };
}

// Back-compat wrapper for callers/tests that only need the turn list. The
// resend-resolvability path uses settleTurnsWithRaw so it also gets the merged
// raw snapshot.
export function settleTurns(args: {
  prev: ChatTurn[] | null;
  messages: unknown[];
  streaming: boolean;
  streamStatus: string;
  hasIngress: boolean;
}): ChatTurn[] | null {
  return settleTurnsWithRaw({ ...args, prevRaw: [] }).turns;
}
