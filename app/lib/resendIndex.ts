// Raw-transcript index resolution for Assistant chat edit/regenerate/retry.
// Contract: the stream request truncates the stored thread to `fromIndex`
// entries, then appends `message`. Positions are indices into the RAW
// transcript message array — entries are counted even when they carry no meta
// (legacy) or only image parts; a missing/unknown role never counts as a user
// turn.
//
// The display view (`turns`) is transcript + optimistic turns; an optimistic
// turn carries `rawIndex: -1` and has no raw position. Resending must always
// target a RAW user message, so a display turn is mapped back onto the raw
// array: its own raw position when it actually holds that user message, else
// the nearest raw user message with the same text AT OR AFTER the floor (so a
// stale raw transcript can never map the optimistic turn onto an older
// identical prompt). A turn that matches nothing resolves to null — callers
// surface a visible error instead of emitting a sentinel index the server would
// reject.

// Text of a raw transcript entry: UIMessage `parts` (D3) concatenated text
// parts, else plain string content, or the concatenated legacy content parts
// (image parts carry no text). Mirrors renderTranscript's extraction so a
// display turn's text compares equal to its raw source.
export function rawMessageText(raw: unknown): string {
  const record = raw as { content?: unknown; parts?: unknown } | undefined;
  if (Array.isArray(record?.parts)) {
    let text = "";
    for (const part of record.parts as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === "text") text += String(part.text ?? "");
    }
    return text;
  }
  const content = record?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content as Array<{ type?: unknown; content?: unknown; text?: unknown }>) {
    if (part?.type === "image-ref") continue;
    text += String(part?.content ?? part?.text ?? "");
  }
  return text;
}

export function rawRoleAt(messages: readonly unknown[], index: number): string | undefined {
  const role = (messages[index] as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : undefined;
}

// Nearest raw user message whose text equals `text` at or after `floor`,
// searching from the end. The floor stops the duplicate-text fallback from
// latching onto an OLDER identical prompt when the raw transcript is stale —
// the server would truncate the thread to that point and drop later prompts.
// Used for optimistic turns (rawIndex -1) and for a stale position that no
// longer points at the same user message.
export function rawUserIndexByText(messages: readonly unknown[], text: string, floor = 0): number | null {
  for (let i = messages.length - 1; i >= floor; i--) {
    if (rawRoleAt(messages, i) === "user" && rawMessageText(messages[i]) === text) return i;
  }
  return null;
}

// Map a display turn ({ rawIndex, text }) onto a RAW user-message index.
// Prefers the turn's exact raw position when it really holds that user message;
// otherwise falls back to the nearest raw user message with the same text at or
// after `floor` (the position just past the last known raw turn — see
// resolveResendTarget). Returns null when no raw user turn matches — the caller
// must not send.
export function resolveRawUserIndex(
  messages: readonly unknown[],
  turn: { rawIndex: number; text: string },
  floor = 0
): number | null {
  if (turn.rawIndex >= 0 && turn.rawIndex < messages.length) {
    if (rawRoleAt(messages, turn.rawIndex) === "user" && rawMessageText(messages[turn.rawIndex]) === turn.text) {
      return turn.rawIndex;
    }
  }
  return rawUserIndexByText(messages, turn.text, floor);
}
