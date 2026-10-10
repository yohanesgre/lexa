// Incremental thread compaction helpers (ADR-0004 §2; ADR-0005 P2).
//
// Thresholds 40 messages / 64 KiB, window 8. `summaryWindow` decides which
// not-yet-summarized prefix to condense so repeated persists of the same
// transcript are idempotent ("threshold once"); the caller (`build-stream.ts`)
// supplies the prior summary to keep the result cumulative and runs the summary
// call itself. Pure — no provider/model imports.

export const SUMMARY_THRESHOLD_MESSAGES = 40;
export const SUMMARY_THRESHOLD_BYTES = 64 * 1024;
export const SUMMARY_WINDOW = 8;

const textEncoder = new TextEncoder();

/** UTF-8 byte length — `String.length` undercounts multibyte characters. */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/** True when the transcript crossed the message or byte threshold. */
export function needsSummary(messages: readonly unknown[]): boolean {
  if (messages.length > SUMMARY_THRESHOLD_MESSAGES) return true;
  try {
    return utf8ByteLength(JSON.stringify(messages)) > SUMMARY_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

export interface SummaryWindow {
  /** Messages to condense now (the not-yet-summarized prefix). */
  older: unknown[];
  /** Total messages condensed after this event (all-but-window). */
  summarizedCount: number;
}

/**
 * Decide what (if anything) to summarize. Returns `null` when the transcript is
 * under threshold or everything outside the window is already summarized.
 * `older` is the incremental slice `[summarizedCount, len - window)` so the
 * provider only sees new content; the caller supplies the prior summary to keep
 * the result cumulative.
 */
export function summaryWindow(messages: readonly unknown[], summarizedCount: number): SummaryWindow | null {
  const safeCount = Number.isFinite(summarizedCount) && summarizedCount > 0 ? Math.floor(summarizedCount) : 0;
  if (!needsSummary(messages)) return null;
  const toSummarize = messages.length - SUMMARY_WINDOW;
  if (toSummarize <= safeCount) return null;
  return { older: messages.slice(safeCount, toSummarize), summarizedCount: toSummarize };
}
