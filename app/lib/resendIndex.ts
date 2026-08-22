// fromIndex computation for Herald chat edit/regenerate/retry (contract:
// the stream request truncates the thread to `fromIndex` entries, then
// appends `message`). Positions are indices into the RAW transcript message
// array — entries are counted even when they carry no meta (legacy) or only
// image parts; a missing/unknown role never counts as a user turn.
export type ResendMode = "edit" | "regenerate" | "retry";

// edit → index of the user entry being edited (editedAt must point at a
//   user entry — the thread forks from there);
// regenerate/retry → index of the LAST user entry (the trailing assistant
//   turns — live reply, failed or stopped partial — are dropped and the
//   triggering user message is resent).
// Returns null when no valid target exists (empty thread, no user turns,
// editedAt out of range or not a user entry).
export function resendIndex(
  messages: readonly unknown[],
  mode: ResendMode,
  editedAt?: number
): number | null {
  const roleAt = (i: number): string | undefined => {
    const role = (messages[i] as { role?: unknown } | undefined)?.role;
    return typeof role === "string" ? role : undefined;
  };

  if (mode === "edit") {
    if (editedAt === undefined || editedAt < 0 || editedAt >= messages.length) return null;
    return roleAt(editedAt) === "user" ? editedAt : null;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleAt(i) === "user") return i;
  }
  return null;
}
