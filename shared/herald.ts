import type { ID, ISODate } from "./types";

export type ProviderKind = "openai_compatible" | "anthropic_compatible" | "openai_responses";

export type HearthEngine = "herald" | "blacksmith";

export type HeraldReasoningEffort = "minimal" | "low" | "medium" | "high";

export const HERALD_PRE_INGRESS_TIMEOUT_MS = 30_000;
export const HERALD_STALL_TIMEOUT_MS = 90_000;
export const HERALD_STALL_MESSAGE = "stream stalled — no response from provider";
export const STREAM_STALL_TIMEOUT_MS = HERALD_STALL_TIMEOUT_MS;
export const STREAM_STALL_MESSAGE = HERALD_STALL_MESSAGE;
export const PRE_INGRESS_TIMEOUT_MS = HERALD_PRE_INGRESS_TIMEOUT_MS;

export interface HeraldSettingsMasked {
  projectId: ID;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  engine: HearthEngine;
  engineSwitcherEnabled: boolean;
  primarySupportsImages: boolean;
  reasoningEffort: HeraldReasoningEffort | null;
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

export interface HeraldSettingsInput {
  providerId?: string | null | undefined;
  modelId?: string | null | undefined;
  searchProvider?: "exa" | null | undefined;
  searchApiKey?: string | null | undefined;
  urlAllowlist?: string | null | undefined;
  engine?: HearthEngine | undefined;
  engineSwitcherEnabled?: boolean | undefined;
  primarySupportsImages?: boolean | undefined;
  reasoningEffort?: HeraldReasoningEffort | null | undefined;
  writeTools?: readonly string[] | string[] | undefined;
  fallbackModelIds?: readonly string[] | string[] | undefined;
  kind?: ProviderKind | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  visionModel?: string | null | undefined;
}

export type HeraldCallLogStatus = "done" | "error" | "suspended" | "aborted";
export type HeraldCallLogKind = ProviderKind;

export interface HeraldProviderMasked {
  id: ID;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  keyMask: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
  models?: HeraldProviderModel[];
}

export interface HeraldModelRow {
  id: ID;
  providerId: ID;
  modelId: string;
  kind: ProviderKind;
  priority: number;
  enabled: boolean;
  createdAt: ISODate;
}

export interface HeraldModelInput {
  providerId: ID;
  modelId: string;
  kind: ProviderKind;
  priority?: number | undefined;
  enabled?: boolean | undefined;
}

export interface HeraldCallLogRow {
  id: ID;
  projectId: ID | null;
  providerId: ID | null;
  model: string;
  kind: ProviderKind;
  status: HeraldCallLogStatus;
  errorCode: string | null;
  usageIn: number;
  usageOut: number;
  cachedIn: number;
  latencyMs: number | null;
  costCents: number;
  estimated: boolean;
  createdAt: ISODate;
}

export interface HeraldCallLogInput {
  projectId?: ID | null | undefined;
  providerId?: ID | null | undefined;
  model: string;
  kind: ProviderKind;
  status: HeraldCallLogStatus;
  errorCode?: string | null | undefined;
  usageIn?: number | undefined;
  usageOut?: number | undefined;
  cachedIn?: number | undefined;
  latencyMs?: number | null | undefined;
  costCents?: number | undefined;
  estimated?: boolean | undefined;
}

export interface HeraldModelPrice {
  model: string;
  promptPrice: number;
  completionPrice: number;
  updatedAt: ISODate;
}

export interface HeraldModelPriceInput {
  model: string;
  promptPrice: number;
  completionPrice: number;
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
      diff: HeraldWriteDiff;
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

export type HeraldWriteDiff =
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
  | { type: "comment"; taskRef: string; taskTitle: string; bodyText: string }
  | { type: "wiki_create"; slug: string; title: string; bodyText: string }
  | { type: "wiki_edit"; slug: string; title: string; beforeText: string; afterText: string }
  | { type: "milestone_create"; name: string; dueAt?: string }
  | { type: "milestone_update"; name: string; changes?: Array<{ field: string; before: string | null; after: string | null }> }
  | { type: "milestone_archive"; name: string; sprintsAffected?: number }
  | { type: "sprint_create"; name: string; startAt?: string; dueAt?: string }
  | { type: "sprint_update"; name: string; changes?: Array<{ field: string; before: string | null; after: string | null }> };

export type HeraldThreadType = "task" | "wiki" | "chat";

export interface HeraldChatStreamRequest {
  projectId: ID;
  chatId: string;
  message: string;
  agentId?: string | undefined;
  skillId?: string | undefined;
  attachments?: HeraldChatAttachment[] | undefined;
  fromIndex?: number | undefined;
  reasoningEffort?: HeraldReasoningEffort | null | undefined;
}

export interface HeraldChatAttachment {
  storageKey: string;
  mimeType: string;
  name: string;
}

export interface HeraldChatTranscript {
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

export interface HeraldChatThreadSummary {
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

export interface HeraldProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  kind: ProviderKind;
  priority: number;
  enabled: boolean;
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

export interface HeraldProvider {
  id: string;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  keyMask: string | null;
  models: HeraldProviderModel[];
  createdAt?: ISODate;
  updatedAt?: ISODate;
}

export interface HeraldProviderInput {
  label: string;
  baseUrl: string;
  apiKey?: string | undefined;
}

export interface HeraldProviderTestResult {
  ok: boolean;
  latencyMs: number;
}

export interface HeraldUsage {
  totalCalls: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byProject: Array<{ projectId: string; projectName: string; calls: number; tokensIn: number; tokensOut: number }>;
}

export interface HeraldCall {
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

export interface HeraldProjectSettings {
  projectId: string;
  providerId: string | null;
  modelId: string | null;
  fallbackModelIds: string[];
  hasKey?: boolean;
  keyMask?: string | null;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  engine: HearthEngine;
  engineSwitcherEnabled: boolean;
  reasoningEffort: HeraldReasoningEffort | null;
  writeTools: string[];
}
