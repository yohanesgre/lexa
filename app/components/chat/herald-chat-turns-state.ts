import { renderTranscript } from "./herald-chat-utils";
import type { ChatTurn } from "./herald-chat-utils";

// Turn-settle policy for the Herald chat transcript (pure): merge the
// server transcript with the live optimistic view. Ephemeral user turns
// (rawIndex -1) ride along while the stream is live so a send is never
// visually dropped; a fresh shorter server list during an active stream is
// ignored; a failed turn is kept while the stream still holds ingress.

export function settleTurns(args: {
  prev: ChatTurn[] | null;
  messages: unknown[];
  streaming: boolean;
  streamStatus: string;
  hasIngress: boolean;
}): ChatTurn[] | null {
  const { prev, messages, streaming, streamStatus, hasIngress } = args;
  const serverTurns = renderTranscript(messages);
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
