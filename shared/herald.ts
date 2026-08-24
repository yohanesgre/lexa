import type { ID, ISODate } from "./types";

export type ProviderKind = "openai_compatible" | "anthropic_compatible";

export type HearthEngine = "herald" | "blacksmith";

export type HeraldReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface HeraldSettingsMasked {
  projectId: ID;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: true;
  keyMask: string | null;
  searchProvider: "exa" | null;
  hasSearchKey: boolean;
  urlAllowlist: string | null;
  engine: HearthEngine;
  engineSwitcherEnabled: boolean;
  primarySupportsImages: boolean;
  visionModel: string | null;
  reasoningEffort: HeraldReasoningEffort | null;
}

export interface HeraldSettingsInput {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  searchProvider?: "exa" | null;
  searchApiKey?: string | null;
  urlAllowlist?: string | null;
  engine?: HearthEngine;
  engineSwitcherEnabled?: boolean;
  primarySupportsImages?: boolean;
  visionModel?: string | null;
  reasoningEffort?: HeraldReasoningEffort | null;
}

export type StreamFrame =
  | { type: "start"; taskId?: string; chatId?: string; threadId: string }
  | { type: "delta"; text: string }
  // Ephemeral chain-of-thought from reasoning models (REASONING_MESSAGE_CONTENT
  // chunks). Streamed live, never persisted into herald_threads.
  | { type: "reasoning"; delta: string }
  // detail: short human-readable summary of the call INPUT (e.g.
  // `Searching wiki for "auth"`), built server-side from the validated args.
  // Present on both the call and result frames for easy rendering.
  | { type: "tool"; phase: "call" | "result"; name: string; arg?: string; detail?: string }
  | { type: "error"; code: string; message: string }
  | { type: "done"; taskId?: string; chatId?: string; text: string; usage: { in: number; out: number } };

export type HeraldThreadType = "task" | "wiki" | "chat";

export interface HeraldChatStreamRequest {
  projectId: ID;
  chatId: string;
  message: string;
  agentId?: string;
  skillId?: string;
  attachments?: HeraldChatAttachment[];
  // Edit/regenerate/retry: truncate the transcript to this index before
  // appending the new turn. Omitted or === messages.length → plain append.
  fromIndex?: number;
  // Per-turn reasoning effort override; absent/null falls back to the
  // project default (herald_settings.reasoning_effort). Both unset → the
  // provider request carries no reasoning_effort param.
  reasoningEffort?: HeraldReasoningEffort | null;
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
  // Short window around the first transcript match when the list was
  // filtered with ?q= — null for title-only matches or unfiltered lists.
  snippet: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// A source Herald cited in an assistant turn (web_search result or fetch_url
// target). Persisted inline in the transcript JSON, ≤10 per turn,
// URL-deduped, https-only.
export interface Citation {
  title: string | null;
  url: string;
}

// ChatMessageMeta — per-entry metadata stored INLINE in the transcript JSON
// (herald_threads.messages), never a separate table:
// - user entries may carry `ts` (ISO send timestamp);
// - assistant entries may carry `ts`, `citations: Citation[]`, and exactly
//   one terminal marker: `error: {code, message}` (generation failure) or
//   `stopped: true` (client abort with partial text).

// Chat thread list label from the first user message: newlines become
// spaces, whitespace runs collapse, ≤60 chars. Empty/whitespace-only input
// yields "" (callers store NULL).
export function deriveChatTitle(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface ModelListResult {
  models: { id: string }[];
}
