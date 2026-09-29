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

// A transcript rebuild loses this session's chip decisions: a persisted
// approval whose `status` was never reconciled maps back to pending
// (chipFromPendingApproval), re-arming a chip we already decided and re-POSTing
// it (409 burst). Overlay KNOWN terminal decisions from the optimistic view by
// approvalId. Only terminal states propagate — an approval still pending in
// `prev`, or absent from it, keeps the rebuilt state. Never mutates the input.
export function carryKnownDecisions(prev: ChatTurn[] | null, turns: ChatTurn[]): ChatTurn[] {
  const decided = new Map<string, ApprovalChip["state"]>();
  for (const t of prev ?? []) {
    for (const c of t.batch?.chips ?? []) {
      if (TERMINAL_CHIP_STATES.has(c.state)) decided.set(c.approvalId, c.state);
    }
  }
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
  if (liveApproval) return prev;
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
