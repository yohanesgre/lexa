import type { ID, ISODate } from "./types";

export type ProviderKind = "openai_compatible" | "anthropic_compatible" | "openai_responses";

export type RuntimeEngine = "assistant" | "blacksmith";

export type AssistantReasoningEffort = "minimal" | "low" | "medium" | "high";

export const ASSISTANT_PRE_INGRESS_TIMEOUT_MS = 30_000;
export const ASSISTANT_STALL_TIMEOUT_MS = 90_000;
export const ASSISTANT_STALL_MESSAGE = "stream stalled — no response from provider";

export interface AssistantSettingsMasked {
  projectId: ID;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  engine: RuntimeEngine;
  engineSwitcherEnabled: boolean;
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
  engine?: RuntimeEngine | undefined;
  engineSwitcherEnabled?: boolean | undefined;
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
  | { type: "approval_result"; approvalId: string; status: "applied" | "failed" | "denied"; error?: string }
  | { type: "done"; taskId?: string; chatId?: string; text: string; usage: { in: number; out: number } }
  | { type: "suspended"; batchId: string };

export interface PendingBatchApproval {
  approvalId: string;
  toolCallId: string;
}

export interface PendingBatchMarker {
  batchId: string;
  approvals: PendingBatchApproval[];
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
  skillId?: string | undefined;
  attachments?: AssistantChatAttachment[] | undefined;
  fromIndex?: number | undefined;
  reasoningEffort?: AssistantReasoningEffort | null | undefined;
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
  engine: RuntimeEngine;
  engineSwitcherEnabled: boolean;
  reasoningEffort: AssistantReasoningEffort | null;
  writeTools: string[];
}
