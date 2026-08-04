// Forge activity-log level classification — the ONE place that decides
// severity, used by the daemon at write time (stored on the row) and as a
// fallback by the UI for legacy rows. The UI never re-classifies stored
// levels; this is pure and unit-tested (shared/forge-log.test.ts).
//
// stderr ≠ error: CLI agents (opencode especially) write plenty of non-error
// output to stderr (progress, token usage, status). The danger tier is
// conservative — red is expensive, prefer false negatives over false
// positives. Retries/backoffs/rate-limits land in the warn tier instead.
export type LogLevel = "info" | "warn" | "error";
export type LogStream = "out" | "err";

const ERROR_RE =
  /\b(error|fail(?:ed|ure)?|exception|fatal|denied|refused|panic|unable|couldn'?t)\b|\btimeout|\btimed out/i;
// Warn phrases only — bare words like "warn"/"skip"/"slow"/"limit" match
// filenames and prose inside tool output (verified against real opencode
// stderr: an `ls` line containing "warn.txt" was the only false positive).
const WARN_RE =
  /\b(retry(?:ing)?|rate limit|back(?:ing)? ?off|warning:|deprecat(?:ed|ion)?|fallback|degraded|unavailable|attempt \d)\b/i;

// Heuristics apply to stderr only — stdout carries the agent's actual output
// (opencode --print emits the model result there) and is always info.
export function classifyLogLine(stream: LogStream, message: string): { level: LogLevel } {
  if (stream !== "err") return { level: "info" };
  const text = message.replace(/^\[stderr\]\s*/, "").replace(/^\u25B8\s*/, "");
  if (ERROR_RE.test(text)) return { level: "error" };
  if (WARN_RE.test(text)) return { level: "warn" };
  return { level: "info" };
}
