import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import type { AssistantRunRow, AssistantRunStatus } from "../../shared/assistant";

// Pure adapter for the delegated run card (ADR-0004; herald-chat.html §
// run-cards + herald-chat-upgrades.html § delegated-run replay).
//
// The card is PERSISTED (an `assistant_runs` row discovered from the spawning
// turn's `spawn_run` tool output) but its step/event log is SESSION MEMORY ONLY:
// live `agent-tool-event` frames arrive in this tab only and are never
// reconstructed after a reload. Everything here is pure — no React, no socket —
// so the state map, the spawn-runId extraction, and the replay boundary are
// unit-testable without a DOM.

export type RunCardState = "dispatching" | "running" | "done" | "failed" | "stopped";

/** Registry status → card state (herald-chat.html "STATES map 1:1"). */
export function runStatusToCardState(status: AssistantRunStatus): RunCardState {
  switch (status) {
    case "queued":
      return "dispatching";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
}

/** SDK agent-tool run status → card state (live frames in THIS tab only). */
export type LiveRunStatus = "running" | "completed" | "error" | "aborted" | "interrupted";

export function liveStatusToCardState(status: LiveRunStatus): RunCardState {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "aborted":
      return "stopped";
    case "error":
    case "interrupted":
      return "failed";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// AI SDK tool parts carry either a `tool-<name>` type or the dynamic
// `dynamic-tool` discriminator; both expose `toolCallId`/`state`/`input`/`output`.
function isToolPart(part: unknown): part is ToolUIPart | DynamicToolUIPart {
  const type = asRecord(part)?.type;
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

export interface SpawnedRunRef {
  runId: string;
  goal: string;
  toolCallId: string;
}

// Run discovery after a reload: the spawning turn persists the `spawn_run` tool
// part, and its output `{ ok: true, runId }` is the durable pointer back to the
// `assistant_runs` row. Scanned in transcript order, deduped by runId.
export function extractSpawnedRuns(messages: readonly unknown[]): SpawnedRunRef[] {
  const out: SpawnedRunRef[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const parts = asRecord(message)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!isToolPart(part) || getToolName(part) !== "spawn_run") continue;
      if (part.state !== "output-available") continue;
      const output = asRecord(part.output);
      if (!output || output.ok !== true) continue;
      const runId = typeof output.runId === "string" && output.runId.length > 0 ? output.runId : null;
      if (!runId || seen.has(runId)) continue;
      seen.add(runId);
      const input = asRecord(part.input);
      const goal = typeof input?.goal === "string" ? input.goal : "";
      out.push({ runId, goal, toolCallId: part.toolCallId });
    }
  }
  return out;
}

export interface RunEventLine {
  name: string;
  text: string;
  /** `output.applied === true` — an Auto-mode write the run executed itself. */
  auto: boolean;
}

const OUTPUT_TEXT_KEYS = ["detail", "result", "text", "summary", "error"] as const;
const INPUT_TEXT_KEYS = ["detail", "arg", "query", "path", "target"] as const;

function readText(source: Record<string, unknown> | null, keys: readonly string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

function eventText(part: ToolUIPart | DynamicToolUIPart): string {
  if (part.state === "output-error") return part.errorText ?? "";
  const output = asRecord(part.output);
  const fromOutput = readText(output, OUTPUT_TEXT_KEYS);
  if (fromOutput) return fromOutput;
  return readText(asRecord(part.input), INPUT_TEXT_KEYS);
}

/** One live tool part → one event line (`[search_wiki] Reading "…"`). */
export function partToEventLine(part: unknown): RunEventLine | null {
  if (!isToolPart(part)) return null;
  const output = asRecord(part.output);
  return {
    name: getToolName(part),
    text: eventText(part),
    auto: output?.applied === true,
  };
}

export function eventLinesFromParts(parts: readonly unknown[]): RunEventLine[] {
  const out: RunEventLine[] = [];
  for (const part of parts) {
    const line = partToEventLine(part);
    if (line) out.push(line);
  }
  return out;
}

/** Auto-writes applied by the run (`output.applied === true`); live-only. */
export function countAutoWrites(parts: readonly unknown[]): number {
  let count = 0;
  for (const part of parts) if (partToEventLine(part)?.auto) count++;
  return count;
}

// The reload boundary, quoted verbatim from herald-chat-upgrades.html: a reload
// returns persisted columns only and NEVER the live event log.
export const RUN_LOG_REPLAY_BOUNDARY =
  "Persisted run columns are all that reload returns (status · steps_used · started_at · result/error); the live event log is never replayed.";

export interface RunCardModel {
  runId: string;
  goal: string;
  state: RunCardState;
  stepsUsed: number | null;
  result: string | null;
  error: string | null;
  /** Live-only: 0 when the run has no live frames in this tab. */
  autoWrites: number;
  /** Live-only: empty after a reload — never reconstructed. */
  events: RunEventLine[];
  /** True when THIS tab saw live (non-replay) frames for the run. */
  live: boolean;
  /**
   * Captured write mode. `assistant_runs` stores no `mode`, so it is only
   * inferable live (auto-writes prove an Auto run); null otherwise.
   */
  mode: string | null;
}

export function runCardFromPersisted(row: AssistantRunRow): RunCardModel {
  return {
    runId: row.id,
    goal: row.goal,
    state: runStatusToCardState(row.status),
    stepsUsed: row.stepsUsed,
    result: row.result,
    error: row.error,
    autoWrites: 0,
    events: [],
    live: false,
    mode: null,
  };
}

/** Minimal structural view of `agents`' `AgentToolRunState` (keeps this pure). */
export interface LiveRunLike {
  status: LiveRunStatus;
  parts?: readonly unknown[];
  summary?: string;
  error?: string;
  childStillRunning?: boolean;
}

export function runCardFromLive(row: AssistantRunRow, live: LiveRunLike): RunCardModel {
  // `interrupted` is soft while the child may still run (agents SDK): the parent
  // stopped waiting, not the run. Keep it Running rather than fabricating a fail.
  const softInterrupt = live.status === "interrupted" && live.childStillRunning === true;
  const state = softInterrupt ? "running" : liveStatusToCardState(live.status);
  const events = eventLinesFromParts(live.parts ?? []);
  const autoWrites = events.filter((line) => line.auto).length;
  const terminal = state === "done" || state === "failed" || state === "stopped";
  return {
    runId: row.id,
    goal: row.goal,
    state,
    stepsUsed: row.stepsUsed,
    result: live.summary ?? (terminal ? row.result : null),
    error: live.error ?? (state === "failed" ? row.error : null),
    autoWrites,
    events,
    live: true,
    mode: autoWrites > 0 ? "Auto — writes executed without approval (captured at dispatch)" : null,
  };
}

/**
 * Combine the durable row with this tab's live state. Without live frames
 * (reload / another tab) the card falls back to the persisted columns alone.
 */
export function mergeRunCard(
  row: AssistantRunRow,
  live: LiveRunLike | undefined,
  liveInTab: boolean
): RunCardModel {
  return live && liveInTab ? runCardFromLive(row, live) : runCardFromPersisted(row);
}
