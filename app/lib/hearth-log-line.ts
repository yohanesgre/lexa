import { classifyLogLine as classifyFallback, type LogLevel } from "../../shared/hearth-log";

// Line presentation: the daemon classifies severity ONCE at write time
// (shared/hearth-log.ts) and stores stream + level on the row — the UI renders
// the stored level and never re-classifies. Fallback: pre-v2 rows default to
// stream 'out' / level 'info', so rows that still carry the old [stderr]
// marker (a legacy stderr line with a default level) go through the shared
// classifier. The [stderr]/▸ transport markers are stripped visually either
// way; Copy keeps the raw message.
const STDERR_STRIP = "[stderr]";

export function classifyLogLine(line: {
  message: string;
  stream: "out" | "err";
  level: "info" | "warn" | "error";
}): { level: "info" | "warn" | "error"; display: string } {
  const isStderr = line.message.startsWith(STDERR_STRIP);
  const display = isStderr ? line.message.slice(STDERR_STRIP.length).trimStart() : line.message.replace(/^\u25B8\s*/, "");
  const legacy = isStderr && line.level === "info" && line.stream === "out";
  const level: LogLevel = legacy ? classifyFallback("err", line.message).level : line.level;
  return { level, display };
}
