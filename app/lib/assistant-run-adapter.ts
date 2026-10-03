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

// Runner step cap (server/assistant/tool-caps.ts MAX_RUNNER_STEPS). Duplicated
// here as a plain number so the app bundle never pulls the server/`ai` runtime
// in just to render the progress denominator.
export const RUNNER_STEPS_CAP = 16;

// The safe, fixed sentence the failed card renders — upstream bodies are never
// echoed (herald-chat.html:461). Catalog codes render above it in mono.
export const RUN_FAILED_MESSAGE = "The run stopped before finishing. Writes applied before the stop remain.";

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

// Real tool outputs are structured, never a generic `detail` string
// (server/assistant/tools.ts, tools-ai.ts, write-tools.ts): a read keys its
// payload by tool (`{results}` / `{content}` / `{task}` / `{tasks}` / `{page}` /
// `{pages}`), and a write answers `{ok, applied, result}` (auto),
// `{ok, proposed, detail, …}` (ask) or `{ok, denied, error}` (blocked). So the
// line is summarised from the tool name + input, and the output only enriches a
// write. Copy shapes mirror herald-chat.html / herald-chat-upgrades.html:
// `[search_wiki] Reading "cutover-runbook"`, `[edit_wiki_page] Added rollback
// section`. A line is NEVER empty for a tool call.

function str(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** `ref` (one task) or `refs` (a bulk call) as a short label. */
function taskRefLabel(input: Record<string, unknown> | null): string {
  if (!input) return "";
  const ref = str(input.ref);
  if (ref) return ref;
  const refs = stringArray(input.refs);
  return refs.length > 0 ? `${refs.length} tasks` : "";
}

const quoted = (prefix: string, value: string): string => (value ? `${prefix} "${value}"` : prefix);
const plain = (prefix: string, value: string): string => (value ? `${prefix} ${value}` : prefix);

// Reads: identify the call from its input (query / slug / ref / url / key /
// path). Mirrors `toolCallDetail` (server/assistant/tools.ts) but stays a pure
// app module so the bundle never imports the server tool runtime.
const READ_SUMMARIZERS: Record<string, (input: Record<string, unknown> | null) => string> = {
  web_search: (i) => quoted("Searching the web", str(i?.query)),
  search_tasks: (i) => quoted("Searching tasks", str(i?.query)),
  search_wiki: (i) => quoted("Reading", str(i?.query)),
  read_wiki_page: (i) => quoted("Reading", str(i?.slug)),
  read_repo_file: (i) => plain("Reading", str(i?.path)),
  read_s3_file: (i) => plain("Reading", str(i?.key)),
  list_repo_files: () => "Listing repo files",
  fetch_url: (i) => plain("Reading", str(i?.url)),
  get_task: (i) => plain("Reading", str(i?.ref)),
  get_skill: (i) => quoted("Reading skill", str(i?.name)),
  analyze_image: (i) => quoted("Analyzing image", str(i?.question)),
  get_all_tasks: () => "Reading all tasks",
  get_all_wiki_pages: () => "Reading all wiki pages",
  get_board_structure: () => "Reading board structure",
  jev_assess: (i) => {
    const questions = asRecord(i?.["questions"]);
    const n = questions ? Object.keys(questions).length : 0;
    return n > 0 ? `Asking Jev ${n} question${n === 1 ? "" : "s"}` : "Asking Jev";
  },
};

// Writes: the approval/proposal detail if carried, else the applied result's
// id/key, else this name + arg summary. A tool name absent here still falls back
// to `genericText`, so a write with an opaque output never yields an empty line.
const WRITE_SUMMARIZERS: Record<string, (input: Record<string, unknown> | null) => string> = {
  create_task: (i) => quoted("Create task", str(i?.title)),
  update_task: (i) => plain("Update", taskRefLabel(i)),
  move_task: (i) => plain("Move", taskRefLabel(i)),
  archive_task: (i) => plain("Archive", taskRefLabel(i)),
  restore_task: (i) => plain("Restore", taskRefLabel(i)),
  delete_task: (i) => plain("Delete", taskRefLabel(i)),
  add_comment: (i) => plain("Comment on", taskRefLabel(i)),
  create_wiki_page: (i) => quoted("Create page", str(i?.slug)),
  edit_wiki_page: (i) => quoted("Edit page", str(i?.slug)),
  delete_wiki_page: (i) => quoted("Delete page", str(i?.slug)),
  create_milestone: (i) => quoted("Create milestone", str(i?.name)),
  update_milestone: (i) => plain("Update milestone", str(i?.milestoneId)),
  archive_milestone: (i) => plain("Archive milestone", str(i?.milestoneId)),
  delete_milestone: (i) => plain("Delete milestone", str(i?.milestoneId)),
  create_sprint: (i) => quoted("Create sprint", str(i?.name)),
  update_sprint: (i) => plain("Update sprint", str(i?.swimlaneId)),
  archive_sprint: (i) => plain("Archive sprint", str(i?.swimlaneId)),
  delete_sprint: (i) => plain("Delete sprint", str(i?.swimlaneId)),
  move_swimlane: (i) => plain("Move swimlane", str(i?.swimlaneId)),
};

/** An applied write result is a task/page/milestone/… — surface its id/key. */
function resultRef(value: unknown): string {
  const obj = asRecord(value);
  if (!obj) return "";
  for (const key of ["key", "slug", "name", "title", "id"]) {
    const v = str(obj[key]);
    if (v) return v;
  }
  const applied = stringArray(obj["applied"]);
  return applied.length > 0 ? `${applied.length} tasks` : "";
}

function firstNonEmpty(source: Record<string, unknown> | null, keys: readonly string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = str(source[key]);
    if (value) return value;
  }
  return "";
}

function firstArrayLabel(source: Record<string, unknown> | null): string {
  if (!source) return "";
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value) && value.length > 0) return `${value.length} ${key}`;
  }
  return "";
}

const IDENTIFIER_KEYS = [
  "query", "slug", "ref", "key", "url", "path", "name", "title", "milestoneId", "swimlaneId", "taskId",
] as const;

/** Last-resort line for an unknown tool / MCP descriptor — never empty. */
function genericText(
  part: ToolUIPart | DynamicToolUIPart,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): string {
  const fromOutput = firstNonEmpty(output, ["detail", "result", "text", "summary", "content", "message"]);
  if (fromOutput) return fromOutput;
  const array = firstArrayLabel(output);
  if (array) return array;
  const ident = firstNonEmpty(input, IDENTIFIER_KEYS);
  if (ident) return ident;
  return part.state === "output-available" ? "Completed" : "Running";
}

function eventText(part: ToolUIPart | DynamicToolUIPart): string {
  const name = getToolName(part);
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  if (part.state === "output-error") {
    const errorText = str(part.errorText);
    if (errorText) return errorText;
  }
  const error = str(output?.["error"]);
  if (error) return error;
  if (output && (output["applied"] === true || output["proposed"] === true || output["denied"] === true)) {
    const detail = str(output["detail"]);
    if (detail) return detail;
    const ref = resultRef(output["result"]);
    if (ref) return ref;
    return WRITE_SUMMARIZERS[name]?.(input) ?? genericText(part, input, output);
  }
  const read = READ_SUMMARIZERS[name];
  if (read) return read(input);
  const write = WRITE_SUMMARIZERS[name];
  if (write) return write(input);
  return genericText(part, input, output);
}

/** One live tool part → one event line (`[search_wiki] Reading "…"`). */
export function partToEventLine(part: unknown): RunEventLine | null {
  if (!isToolPart(part)) return null;
  const output = asRecord(part.output);
  return {
    name: getToolName(part),
    text: eventText(part),
    auto: output?.["applied"] === true,
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
   * Inferred write mode. `assistant_runs` stores no `mode`, so it is only
   * inferable live (an applied write proves an Auto run); null otherwise.
   */
  mode: string | null;
  /** Persisted `started_at` — drives the elapsed counter (null before dispatch). */
  startedAt: string | null;
  /** Persisted `finished_at` (null while running). */
  finishedAt: string | null;
  /** Runner time budget in ms (`assistant_runs.budget_ms`). */
  budgetMs: number | null;
  /**
   * Live-only: latest `AgentToolRunState.progress.fraction`, the determinate
   * bar's preferred fill. Null until the runner reports a step frame.
   */
  progressFraction: number | null;
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
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    budgetMs: row.budgetMs,
    progressFraction: null,
  };
}

/** Minimal structural view of `agents`' `AgentToolRunState` (keeps this pure). */
export interface LiveRunLike {
  status: LiveRunStatus;
  parts?: readonly unknown[];
  summary?: string;
  error?: string;
  childStillRunning?: boolean;
  progress?: { fraction?: number | undefined } | undefined;
}

function liveProgressFraction(live: LiveRunLike): number | null {
  const fraction = live.progress?.fraction;
  return typeof fraction === "number" && Number.isFinite(fraction) ? fraction : null;
}

/**
 * @param liveFrom Number of LEADING parts that arrived as replayed history (not
 * live in this tab). Sliced off before projecting event lines, so a two-tab /
 * post-reconnect run never renders replayed frames as its live log.
 */
export function runCardFromLive(row: AssistantRunRow, live: LiveRunLike, liveFrom = 0): RunCardModel {
  // `interrupted` is soft while the child may still run (agents SDK): the parent
  // stopped waiting, not the run. Keep it Running rather than fabricating a fail.
  const softInterrupt = live.status === "interrupted" && live.childStillRunning === true;
  const state = softInterrupt ? "running" : liveStatusToCardState(live.status);
  // Replay boundary: only parts after the replayed prefix count as this tab's
  // live log (see `RunCardModel.live`).
  const liveParts = liveFrom > 0 ? (live.parts ?? []).slice(liveFrom) : live.parts ?? [];
  const events = eventLinesFromParts(liveParts);
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
    mode: autoWrites > 0 ? "Auto — writes executed without approval (inferred)" : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    budgetMs: row.budgetMs,
    progressFraction: liveProgressFraction(live),
  };
}

/**
 * Combine the durable row with this tab's live state. Without live frames
 * (reload / another tab) the card falls back to the persisted columns alone.
 *
 * @param liveFrom Leading replayed parts to exclude from the live event log.
 */
export function mergeRunCard(
  row: AssistantRunRow,
  live: LiveRunLike | undefined,
  liveInTab: boolean,
  liveFrom = 0
): RunCardModel {
  return live && liveInTab ? runCardFromLive(row, live, liveFrom) : runCardFromPersisted(row);
}

// ── Timing + progress copy (pure) ───────────────────────────────────────────

/**
 * Parse an `assistant_runs` timestamp. SQLite `datetime('now')` yields
 * `YYYY-MM-DD HH:MM:SS` (UTC, no zone); normalize it before `Date.parse`, which
 * would otherwise read the space form as LOCAL time.
 */
export function parseRunTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Elapsed wall time; terminal runs use `finishedAt`, live runs use `now`. */
export function runElapsedMs(
  startedAt: string | null,
  finishedAt: string | null,
  now: number
): number | null {
  const start = parseRunTimestamp(startedAt);
  if (start === null) return null;
  const end = parseRunTimestamp(finishedAt) ?? now;
  return Math.max(0, end - start);
}

/** `38s` / `4m 12s` / `10m` / `1h 5m` — wireframe-style compact durations. */
export function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Drill-in `Budget` row: `38s / 10m · 16 / 16 steps` (herald-chat.html:520). */
export function runBudgetDetail(model: RunCardModel, now: number): string {
  const elapsed = runElapsedMs(model.startedAt, model.finishedAt, now);
  const elapsedLabel = elapsed === null ? "—" : formatRunDuration(elapsed);
  const budgetLabel = model.budgetMs === null ? "—" : formatRunDuration(model.budgetMs);
  const steps = model.stepsUsed ?? 0;
  return `${elapsedLabel} / ${budgetLabel} · ${steps} / ${RUNNER_STEPS_CAP} steps`;
}
