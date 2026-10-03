import type { ID, ISODate } from "./types";

export type ProviderKind = "openai_compatible" | "anthropic_compatible" | "openai_responses" | "workers_ai";

export type AssistantReasoningEffort = "minimal" | "low" | "medium" | "high";

// Per-thread WRITE-tool permission mode (D1–D8). Read tools are unaffected.
//   ask  → write tools propose; the turn suspends for per-chip approval (today)
//   auto → write tools execute immediately (no pending row, no chips, no suspend)
//   deny → write tools refuse with a model-readable result; reads still work
export type AssistantToolPermissionMode = "ask" | "auto" | "deny";

export const ASSISTANT_TOOL_PERMISSION_MODES: readonly AssistantToolPermissionMode[] = ["ask", "auto", "deny"];

// Envelope validation: anything that is not a known mode (missing, null, a stale
// value) resolves to "ask" — the conservative default (D5).
export function parseAssistantToolPermissionMode(value: unknown): AssistantToolPermissionMode {
  return value === "auto" || value === "deny" ? value : "ask";
}

// Turn-start capture (D2/D6): the send envelope overrides the thread's sticky
// value; an absent envelope (a tool continuation, an old client) keeps sticky.
// Unknown sticky (a pre-column DO row) resolves to "ask".
export function resolveAssistantToolPermissionMode(
  envelopeValue: unknown,
  sticky: unknown
): AssistantToolPermissionMode {
  if (envelopeValue !== undefined) return parseAssistantToolPermissionMode(envelopeValue);
  return sticky === "auto" || sticky === "deny" ? sticky : "ask";
}

// D5 scope: the picker is chat-only. A task/wiki run has no control and must
// stay "ask" even when a crafted send envelope carries a mode.
export function resolveThreadToolPermissionMode(
  documentType: "chat" | "task" | "wiki" | null,
  envelopeValue: unknown,
  sticky: unknown
): AssistantToolPermissionMode {
  if (documentType !== "chat") return "ask";
  return resolveAssistantToolPermissionMode(envelopeValue, sticky);
}

export const ASSISTANT_PRE_INGRESS_TIMEOUT_MS = 30_000;
export const ASSISTANT_STALL_TIMEOUT_MS = 90_000;
export const ASSISTANT_STALL_MESSAGE = "stream stalled — no response from provider";

// Canonical Assistant write-tool names, in approval-chip order. Single source
// of truth for the settings checkbox list and the runtime registry: the DO-side
// `server/assistant/write-tool-names.ts` re-exports this list, so the UI can
// never drift from the registered tools. Pure data — no `@tanstack/ai` import.
export const ASSISTANT_WRITE_TOOL_NAMES = [
  "create_task",
  "update_task",
  "move_task",
  "archive_task",
  "restore_task",
  "delete_task",
  "add_comment",
  "create_wiki_page",
  "edit_wiki_page",
  "delete_wiki_page",
  "create_milestone",
  "update_milestone",
  "archive_milestone",
  "delete_milestone",
  "create_sprint",
  "update_sprint",
  "archive_sprint",
  "delete_sprint",
  "move_swimlane",
] as const;

export interface AssistantSettingsMasked {
  projectId: ID;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  primarySupportsImages: boolean;
  reasoningEffort: AssistantReasoningEffort | null;
  writeTools: string[];
  providerId: string | null;
  modelId: string | null;
  fallbackModelIds?: string[];
  kind?: ProviderKind;
  baseUrl?: string;
  model?: string;
  hasKey?: boolean;
  keyMask?: string | null;
  visionModel?: string | null;
}

export interface AssistantSettingsInput {
  providerId?: string | null | undefined;
  modelId?: string | null | undefined;
  searchProvider?: "exa" | null | undefined;
  searchApiKey?: string | null | undefined;
  urlAllowlist?: string | null | undefined;
  primarySupportsImages?: boolean | undefined;
  reasoningEffort?: AssistantReasoningEffort | null | undefined;
  writeTools?: readonly string[] | string[] | undefined;
  fallbackModelIds?: readonly string[] | string[] | undefined;
  kind?: ProviderKind | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  visionModel?: string | null | undefined;
}

export type AssistantCallLogStatus = "done" | "error" | "suspended" | "aborted";
export type AssistantCallLogKind = ProviderKind;

export interface AssistantProviderMasked {
  id: ID;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  keyMask: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  models?: AssistantProviderModel[];
}

export interface AssistantModelRow {
  id: ID;
  providerId: ID;
  modelId: string;
  kind: ProviderKind;
  priority: number;
  enabled: boolean;
  createdAt: ISODate;
}

export interface AssistantModelInput {
  providerId: ID;
  modelId: string;
  kind: ProviderKind;
  priority?: number | undefined;
  enabled?: boolean | undefined;
}

export interface AssistantCallLogRow {
  id: ID;
  projectId: ID | null;
  providerId: ID | null;
  model: string;
  kind: ProviderKind;
  status: AssistantCallLogStatus;
  errorCode: string | null;
  usageIn: number;
  usageOut: number;
  cachedIn: number;
  latencyMs: number | null;
  costCents: number;
  estimated: boolean;
  createdAt: ISODate;
}

export interface AssistantCallLogInput {
  projectId?: ID | null | undefined;
  providerId?: ID | null | undefined;
  model: string;
  kind: ProviderKind;
  status: AssistantCallLogStatus;
  errorCode?: string | null | undefined;
  usageIn?: number | undefined;
  usageOut?: number | undefined;
  cachedIn?: number | undefined;
  latencyMs?: number | null | undefined;
  costCents?: number | undefined;
  estimated?: boolean | undefined;
}

// ── Delegation run registry (ADR-0004 §3; H3) ──────────────────────────────
// One row per background/facet run. `chat_run`/`schedule` never emit
// task_activity; `document` rows are the legacy document-run tier. Status
// transitions are atomic conditional UPDATEs and idempotent.
export type AssistantRunKind = "chat_run" | "document" | "schedule";
export type AssistantRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export const ASSISTANT_RUN_TERMINAL_STATUSES: readonly AssistantRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface AssistantRunRow {
  id: ID;
  projectId: ID;
  threadKey: string;
  parentRunId: string | null;
  kind: AssistantRunKind;
  status: AssistantRunStatus;
  goal: string;
  result: string | null;
  error: string | null;
  budgetMs: number | null;
  stepsUsed: number;
  createdBy: ID | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export interface AssistantRunCreateInput {
  projectId: ID;
  threadKey: string;
  kind: AssistantRunKind;
  goal: string;
  /** Explicit registry id (the SDK run id); generated when absent. */
  id?: string | undefined;
  parentRunId?: string | null | undefined;
  budgetMs?: number | null | undefined;
  createdBy?: ID | null | undefined;
  /**
   * Optional concurrency caps enforced inside the registry INSERT (`WHERE
   * (SELECT COUNT(*) …) < cap`), so the check and the write are one atomic
   * statement and parallel spawns cannot both win the last slot.
   */
  maxActiveThread?: number | undefined;
  maxActiveProject?: number | undefined;
}

export interface AssistantRunTransitionInput {
  runId: string;
  projectId: ID;
  status: AssistantRunStatus;
  result?: string | null | undefined;
  error?: string | null | undefined;
  stepsUsed?: number | undefined;
}

// ── Scheduled runs (ADR-0004 §4; H7) ───────────────────────────────────────
export interface AssistantScheduleRow {
  id: ID;
  projectId: ID;
  threadKey: string | null;
  createdBy: ID | null;
  title: string;
  prompt: string;
  cron: string | null;
  intervalSeconds: number | null;
  enabled: boolean;
  nextRunAt: ISODate;
  lastRunAt: ISODate | null;
  lastRunId: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface AssistantScheduleInput {
  title: string;
  prompt: string;
  cron?: string | null | undefined;
  intervalSeconds?: number | null | undefined;
  threadKey?: string | null | undefined;
  enabled?: boolean | undefined;
}

export interface AssistantSchedulePatch {
  title?: string | undefined;
  prompt?: string | undefined;
  cron?: string | null | undefined;
  intervalSeconds?: number | null | undefined;
  threadKey?: string | null | undefined;
  enabled?: boolean | undefined;
}

/**
 * Serializable payload the parent thread DO dispatches into the runner facet
 * (ADR-0004 §3; H3). The runner reconstructs the signed internal identity from
 * `projectId`/`threadKey`/`createdBy` and runs the goal as a background turn.
 */
export interface AssistantRunnerInput {
  runId: string;
  projectId: ID;
  threadKey: string;
  goal: string;
  mode: AssistantToolPermissionMode;
  budgetMs: number;
  createdBy: ID | null;
}

export interface AssistantModelPrice {
  model: string;
  promptPrice: number;
  completionPrice: number;
  cachedReadPrice: number;
  cachedWritePrice: number;
  updatedAt: ISODate;
}

export interface AssistantModelPriceInput {
  model: string;
  promptPrice: number;
  completionPrice: number;
  cachedReadPrice: number;
  cachedWritePrice: number;
}

// A bulk write that partially applied: counts cover the whole batch, `errors`
// carries the per-item failure strings (deduped, first-seen order). Only set on
// an "applied" result whose batch had at least one failing item.
export interface ApprovalPartial {
  applied: number;
  failed: number;
  errors?: string[];
}

export type StreamFrame =
  | { type: "start"; taskId?: string; chatId?: string; threadId: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool"; phase: "call" | "result"; name: string; arg?: string; detail?: string }
  | {
      type: "tool_pending";
      approvalId: string;
      batchId: string;
      seq: number;
      name: string;
      detail?: string;
      diff: AssistantWriteDiff;
    }
  | { type: "error"; code: string; message: string }
  | { type: "approval_result"; approvalId: string; status: "applied" | "failed" | "denied"; error?: string; partial?: ApprovalPartial }
  | { type: "done"; taskId?: string; chatId?: string; text: string; usage: { in: number; out: number } }
  | { type: "suspended"; batchId: string };

export interface PendingBatchApproval {
  approvalId: string;
  toolCallId: string;
  // Full chip payload persisted with the marker so a reload mid-suspension can
  // rebuild the decidable chips from the transcript fetch (no batch-read
  // endpoint). Absent on legacy markers → marker-only waiting indicator.
  seq?: number;
  name?: string;
  detail?: string;
  diff?: AssistantWriteDiff;
  // Run attribution (ADR-0004 §3; plan line 140): the run that proposed this
  // write, so the approval carousel can show which run a chip came from.
  proposedByRunId?: string;
  // Live decision status, reconciled by the transcript read so another tab's
  // decisions surface on fetch. Absent → treated as pending.
  status?: "pending" | "approved" | "rejected" | "expired";
}

export interface PendingBatchMarker {
  batchId: string;
  approvals: PendingBatchApproval[];
}

// D3 carrier (ADR-0003 §B.3): the pending-batch marker persisted with the
// assistant UIMessage as a data part. `type` is the wire part type
// (`data-assistant-approval`); `data` holds the same envelope the legacy
// `PendingBatchMarker` used, so the P4b adapter's `chipsFromDataPart` reads it
// unchanged and a reload mid-suspension rebuilds the decidable chips.
export const ASSISTANT_APPROVAL_DATA_PART = "data-assistant-approval";

export interface AssistantApprovalCarrierApproval {
  approvalId: string;
  seq: number;
  name: string;
  detail?: string;
  diff?: AssistantWriteDiff;
  // Run attribution (ADR-0004 §3; plan line 140): the run that proposed this
  // write. Absent for regular turns; present on run proposals.
  proposedByRunId?: string;
  // Live decision status, reconciled by the transcript read so another tab's
  // decisions surface on fetch. Absent → treated as pending.
  status?: "pending" | "approved" | "rejected" | "expired";
}

export interface AssistantApprovalCarrier {
  batchId: string;
  approvals: AssistantApprovalCarrierApproval[];
}

export type AssistantWriteDiff =
  | { type: "task_create"; title: string; fields: Record<string, string | null> }
  | {
      type: "task_update";
      taskRef: string;
      taskTitle: string;
      changes: Array<{ field: "title" | "description" | "priority" | "type" | "dueAt" | "assignees"; before: string | null; after: string | null }>;
    }
  | { type: "task_move"; taskRef: string; taskTitle: string; fromColumn: string; toColumn: string }
  | { type: "task_archive"; taskRef: string; taskTitle: string }
  | { type: "task_restore"; taskRef: string; taskTitle: string; toColumn: string }
  | { type: "task_delete"; taskRef: string; taskTitle: string }
  | { type: "comment"; taskRef: string; taskTitle: string; bodyText: string }
  | { type: "wiki_create"; slug: string; title: string; bodyText: string }
  | { type: "wiki_edit"; slug: string; title: string; beforeText: string; afterText: string }
  | { type: "wiki_delete"; slug: string; title: string }
  | { type: "milestone_create"; name: string; dueAt?: string }
  | { type: "milestone_update"; name: string; changes?: Array<{ field: string; before: string | null; after: string | null }> }
  | { type: "milestone_archive"; name: string; sprintsAffected?: number }
  | { type: "milestone_delete"; name: string }
  | { type: "sprint_create"; name: string; startAt?: string; dueAt?: string }
  | { type: "sprint_update"; name: string; changes?: Array<{ field: string; before: string | null; after: string | null }> }
  | { type: "sprint_archive"; name: string }
  | { type: "sprint_delete"; name: string }
  | { type: "swimlane_move"; swimlaneId: string; swimlaneName: string; fromMilestone: string | null; toMilestone: string | null };

export type AssistantThreadType = "task" | "wiki" | "chat";

export interface AssistantChatStreamRequest {
  projectId: ID;
  chatId: string;
  message: string;
  agentId?: string | undefined;
  attachments?: AssistantChatAttachment[] | undefined;
  fromIndex?: number | undefined;
  reasoningEffort?: AssistantReasoningEffort | null | undefined;
  // Send envelope: the composer's current WRITE permission mode. Absent → the
  // thread's sticky DO value (pre-mode threads default to "ask").
  permissionMode?: AssistantToolPermissionMode | undefined;
}

export interface AssistantChatAttachment {
  storageKey: string;
  mimeType: string;
  name: string;
}

export interface AssistantChatTranscript {
  chatId: string;
  projectId: ID;
  ownerUserId: ID | null;
  agentId: string | null;
  skillId: string | null;
  // Wire payload decoded via Schema at service boundary — intentionally unknown until validated.
  messages: unknown[];
  summary: string | null;
  summarizedCount: number;
  // Sticky per-thread WRITE permission mode (D2/D5). The composer picker seeds
  // from this on load; an absent/unknown DO value falls back to "ask".
  permissionMode: AssistantToolPermissionMode;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface AssistantChatThreadSummary {
  chatId: string;
  title: string | null;
  pinned: boolean;
  snippet: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Citation {
  title: string | null;
  url: string;
}

export function deriveChatTitle(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface ModelListResult {
  models: { id: string }[];
}

export interface AssistantJevMasked {
  id: "default";
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasKey: boolean;
  keyMask: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface AssistantJevProjectPublic {
  projectId: ID;
  enabled: boolean;
  /**
   * Whether Jev is usable for projects at all — global config enabled AND a
   * stored, decryptable key. Ignores this project's own row, so a member can
   * render the disabled toggle + "configure Jev" notice without superadmin read
   * access. Never key material.
   */
  available: boolean;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

export interface AssistantProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  kind: ProviderKind;
  priority: number;
  enabled: boolean;
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

export interface AssistantProvider {
  id: string;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  keyMask: string | null;
  models: AssistantProviderModel[];
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

export interface AssistantProviderInput {
  label: string;
  baseUrl: string;
  apiKey?: string | undefined;
}

export interface AssistantProviderTestResult {
  ok: boolean;
  latencyMs: number;
}

export interface AssistantUsage {
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byProject: Array<{ projectId: string; projectName: string; calls: number; tokensIn: number; tokensOut: number }>;
}

export interface AssistantCall {
  id: string;
  projectId: string;
  providerId: string | null;
  modelId: string | null;
  status: string;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  errorCode: string | null;
  createdAt: ISODate;
}

export interface AssistantProjectSettings {
  projectId: string;
  providerId: string | null;
  modelId: string | null;
  fallbackModelIds: string[];
  hasKey?: boolean;
  keyMask?: string | null;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  reasoningEffort: AssistantReasoningEffort | null;
  writeTools: string[];
}
