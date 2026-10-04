import type { ChatStatus, DynamicToolUIPart, ToolUIPart, UIDataTypes, UIMessage, UIMessagePart, UITools } from "ai";
import { getToolName, isToolUIPart } from "ai";
import type { AssistantToolPermissionMode, AssistantWriteDiff } from "../../shared/assistant";
import { ASSISTANT_APPROVAL_DATA_PART } from "../../shared/assistant";
import type {
  AssistantPendingChip,
  AssistantStreamSnapshot,
  AssistantStreamStatus,
  AssistantTimelineItem,
  AssistantToolChip,
} from "./use-assistant-stream";

// ADR-0003 P4b (WS1): pure adapter between the AI SDK / `@cloudflare/ai-chat`
// UIMessage wire shape and the app's legacy `StreamFrame`-derived snapshot
// (`AssistantStreamSnapshot`) that AssistantChatTurns / AssistantChatShell /
// assistant-chat-session.ts already render. Keeping the projection here — and
// out of React — means the chat surface is transport-blind: the SSE session
// store and the agent hook both feed it the same snapshot shape.

export interface AgentCitation {
  url: string;
  title: string | null;
  hostname: string;
}

// The parts of a stream snapshot the adapter can derive from UIMessages. The
// session-keyed store adds the transport-only bits (`frames`, terminal status
// transitions).
export interface AgentSegment {
  text: string;
  items: AssistantTimelineItem[];
  tools: AssistantToolChip[];
  // Live approval chips. The P3 engine returns write proposals as ordinary
  // tool outputs (`{ proposed: true, approvalId, seq }`) without a batchId or
  // diff, so a live chip is only reconstructable when the part/data carries
  // the full payload; the diff-bearing batch is the persisted D1 marker read
  // back through the REST transcript (the known P4 gap recorded in
  // herald-write-approvals.html).
  pending: AssistantPendingChip[];
  suspendedBatchId: string | null;
  reasoningText: string;
  reasoningMs: number | null;
  citations: AgentCitation[];
  hasIngress: boolean;
}

export function emptyAgentSegment(): AgentSegment {
  return {
    text: "",
    items: [],
    tools: [],
    pending: [],
    suspendedBatchId: null,
    reasoningText: "",
    reasoningMs: null,
    citations: [],
    hasIngress: false,
  };
}

// Tool name → chip copy. Mirrors the SSE-era labels so a tool call renders the
// same sentence on either transport.
export function agentToolLabel(name: string): string {
  switch (name) {
    case "web_search":
      return "Searching web…";
    case "fetch_url":
    case "read_s3_file":
      return "Reading file…";
    case "jev_assess":
      return "Asking Jev…";
    default:
      return name;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readMessageMetadata(message: UIMessage | undefined): Record<string, unknown> | undefined {
  const metadata = (message as { metadata?: unknown } | undefined)?.metadata;
  return isRecord(metadata) ? metadata : undefined;
}

// A transcript message carries no per-token timestamps, so the only honest
// reasoning duration is one the server attached to the message metadata.
// Absent that, stay null — the done-fold then shows just the tool count rather
// than a fabricated "Thought for <1s".
export function reasoningMsFromMessage(message: UIMessage | undefined): number | null {
  return finiteNumber(readMessageMetadata(message)?.reasoningMs);
}

// `AssistantStreamSnapshot.usage` speaks `{ in, out }`. The server may persist
// it on the assistant message as `metadata.usage`; accept the common alternate
// spellings so a provider-specific shape still surfaces the token chip.
export function usageFromMessage(message: UIMessage | undefined): { in: number; out: number } | null {
  const usage = readMessageMetadata(message)?.usage;
  if (!isRecord(usage)) return null;
  const input = finiteNumber(usage.in) ?? finiteNumber(usage.input) ?? finiteNumber(usage.inputTokens);
  const output = finiteNumber(usage.out) ?? finiteNumber(usage.output) ?? finiteNumber(usage.outputTokens);
  if (input === null && output === null) return null;
  return { in: input ?? 0, out: output ?? 0 };
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Chip copy detail: the server may carry a human sentence on the tool input
// (`detail`), the SSE `StreamFrame.detail` equivalent. Never invents copy.
function detailFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return readString(input, "detail") ?? readString(input, "arg");
}

function resultDetailFromPart(part: ToolUIPart | DynamicToolUIPart): string | undefined {
  if (part.state === "output-error") return part.errorText;
  if (part.state === "output-available") {
    if (typeof part.output === "string") return part.output;
    if (isRecord(part.output)) {
      return (
        readString(part.output, "detail") ??
        readString(part.output, "result") ??
        readString(part.output, "text") ??
        readString(part.output, "error")
      );
    }
  }
  return undefined;
}

// Full chip payload carried on a tool output (forward-compatible: the engine
// may attach the persisted batch metadata to the proposal output).
function chipFromToolOutput(part: ToolUIPart | DynamicToolUIPart, name: string): AssistantPendingChip | null {
  if (part.state !== "output-available" || !isRecord(part.output)) return null;
  const output = part.output;
  const approvalId = readString(output, "approvalId");
  const batchId = readString(output, "batchId");
  const diff = output.diff;
  if (!approvalId || !batchId || !isRecord(diff)) return null;
  const seq = typeof output.seq === "number" && Number.isFinite(output.seq) ? output.seq : 0;
  const detail = readString(output, "detail");
  // A reconciled decision can ride the proposal output itself (the server's
  // `approvalFromProposal` reads `output.status`); carry it as `state` so a
  // terminal carrier is never projected as a still-pending chip.
  const state = pendingState(output);
  return {
    approvalId,
    batchId,
    seq,
    name: readString(output, "name") ?? name,
    ...(detail ? { detail } : {}),
    ...(state ? { state } : {}),
    diff: diff as unknown as AssistantWriteDiff,
  };
}

function citationFromPart(part: { url?: unknown; title?: unknown }): AgentCitation | null {
  const url = part.url;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const title = (part as { title?: unknown }).title;
  return { url, title: typeof title === "string" ? title : null, hostname };
}

// W7b/WS2: a reconciled carrier carries each approval's live decision status;
// surface it on the chip so a reload renders terminal chips instead of
// re-arming them as pending.
function pendingState(source: Record<string, unknown>): AssistantPendingChip["state"] | undefined {
  const status = source.status;
  return status === "pending" || status === "approved" || status === "rejected" || status === "expired" ? status : undefined;
}

// The single-chip shape on a data part (approvalId/batchId/name/diff present).
function singleChipFromData(data: Record<string, unknown>): AssistantPendingChip | null {
  const approvalId = readString(data, "approvalId");
  const batchId = readString(data, "batchId");
  const name = readString(data, "name");
  const diff = data.diff;
  if (!approvalId || !batchId || !name || !isRecord(diff)) return null;
  const seq = typeof data.seq === "number" && Number.isFinite(data.seq) ? data.seq : 0;
  const detail = readString(data, "detail");
  const state = pendingState(data);
  return { approvalId, batchId, seq, name, ...(detail ? { detail } : {}), ...(state ? { state } : {}), diff: diff as unknown as AssistantWriteDiff };
}

// An approval entry inside a `{ batchId, approvals: [...] }` envelope.
function chipFromApproval(raw: unknown, batchId: string, fallbackSeq: number): AssistantPendingChip | null {
  if (!isRecord(raw)) return null;
  const approvalId = readString(raw, "approvalId");
  const name = readString(raw, "name");
  const diff = raw.diff;
  if (!approvalId || !name || !isRecord(diff)) return null;
  const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : fallbackSeq;
  const detail = readString(raw, "detail");
  const state = pendingState(raw);
  return { approvalId, batchId, seq, name, ...(detail ? { detail } : {}), ...(state ? { state } : {}), diff: diff as unknown as AssistantWriteDiff };
}

// One carrier data part → the batch it names plus any reconstructable chips.
// Supports the single-chip payload and the `{ batchId, approvals: [...] }`
// envelope the persisted marker uses. A marker-only carrier (batchId with no
// full chip payload) still yields its batchId so the suspension is not lost.
function carrierFromDataPart(type: string, data: unknown): { batchId: string; chips: AssistantPendingChip[] } | null {
  if (type !== ASSISTANT_APPROVAL_DATA_PART || !isRecord(data)) return null;
  const one = singleChipFromData(data);
  if (one) return { batchId: one.batchId, chips: [one] };
  const batchId = readString(data, "batchId");
  if (!batchId) return null;
  const approvals = data.approvals;
  const chips: AssistantPendingChip[] = [];
  if (Array.isArray(approvals)) {
    for (const raw of approvals) {
      const chip = chipFromApproval(raw, batchId, chips.length);
      if (chip) chips.push(chip);
    }
  }
  return { batchId, chips };
}

// One data part → pending chip(s). The marker-only batchId is dropped here —
// the suspension projection reads the carrier itself (`suspensionFromMessages`).
function chipsFromDataPart(type: string, data: unknown): AssistantPendingChip[] {
  return carrierFromDataPart(type, data)?.chips ?? [];
}

function isAssistantToolPart(part: UIMessagePart<UIDataTypes, UITools>): part is ToolUIPart | DynamicToolUIPart {
  return isToolUIPart(part);
}

// Project one assistant UIMessage into the legacy snapshot. Parts are consumed
// in arrival order so the timeline interleaves reasoning / tool / text exactly
// as the model emitted them; consecutive text parts merge into one item.
export function segmentFromAssistantMessage(message: UIMessage | undefined): AgentSegment {
  const segment = emptyAgentSegment();
  if (!message || message.role !== "assistant") return segment;

  let itemId = 0;
  const pending: AssistantPendingChip[] = [];
  const citedUrls = new Set<string>();

  const pushText = (text: string) => {
    if (text.length === 0) return;
    segment.hasIngress = true;
    segment.text += text;
    const last = segment.items[segment.items.length - 1];
    if (last?.kind === "text") {
      segment.items[segment.items.length - 1] = { ...last, text: last.text + text };
    } else {
      segment.items.push({ id: itemId++, kind: "text", text });
    }
  };

  const pushReasoning = (text: string) => {
    if (text.length === 0) return;
    segment.hasIngress = true;
    segment.reasoningText += text;
    const last = segment.items[segment.items.length - 1];
    if (last?.kind === "reasoning") {
      segment.items[segment.items.length - 1] = { ...last, text: last.text + text };
    } else {
      // ms stays null: parts carry no server timestamps, so a resumed turn's
      // reasoning burst cannot be timed from the message alone.
      segment.items.push({ id: itemId++, kind: "reasoning", text, ms: null });
    }
  };

  const upsertTool = (name: string, toolCallId: string, phase: "call" | "result", detail?: string, resultDetail?: string) => {
    segment.hasIngress = true;
    const existingIndex = segment.tools.findIndex((t) => t.key === toolCallId);
    const chip: AssistantToolChip = {
      key: toolCallId,
      name,
      label: agentToolLabel(name),
      phase,
      ...(detail ? { detail } : {}),
      ...(resultDetail ? { resultDetail } : {}),
    };
    if (existingIndex >= 0) {
      segment.tools[existingIndex] = { ...segment.tools[existingIndex]!, ...chip, detail: chip.detail ?? segment.tools[existingIndex]!.detail };
      const itemIndex = segment.items.findIndex((it) => it.kind === "tool" && it.chip.key === toolCallId);
      if (itemIndex >= 0) segment.items[itemIndex] = { id: segment.items[itemIndex]!.id, kind: "tool", chip: segment.tools[existingIndex]! };
    } else {
      segment.tools.push(chip);
      segment.items.push({ id: itemId++, kind: "tool", chip });
    }
  };

  for (const part of message.parts) {
    if (part.type === "text") {
      pushText(part.text);
      continue;
    }
    if (part.type === "reasoning") {
      pushReasoning(part.text);
      continue;
    }
    if (part.type === "source-url") {
      const citation = citationFromPart(part);
      // The model can cite one URL across several source parts; render it once.
      if (citation && !citedUrls.has(citation.url)) {
        citedUrls.add(citation.url);
        segment.citations.push(citation);
      }
      continue;
    }
    if (part.type.startsWith("data-")) {
      pending.push(...chipsFromDataPart(part.type, (part as { data?: unknown }).data));
      continue;
    }
    if (!isAssistantToolPart(part)) continue;
    const name = getToolName(part);
    const toolCallId = part.toolCallId;
    const detail = detailFromInput(part.input);
    if (part.state === "output-error") {
      upsertTool(name, toolCallId, "result", detail, resultDetailFromPart(part));
      continue;
    }
    if (part.state === "output-available" || part.state === "output-denied") {
      upsertTool(name, toolCallId, "result", detail, resultDetailFromPart(part));
      const chip = chipFromToolOutput(part, name);
      if (chip) pending.push(chip);
      continue;
    }
    // input-streaming | input-available | approval-requested | approval-responded
    upsertTool(name, toolCallId, "call", detail);
  }

  if (pending.length > 0) {
    pending.sort((a, b) => a.seq - b.seq);
    segment.pending = pending;
    // Only a still-pending approval suspends the turn; a carrier whose chips
    // are all terminal (decided in another tab) must not re-arm the carousel.
    const suspending = pending.find((chip) => (chip.state ?? "pending") === "pending");
    segment.suspendedBatchId = suspending?.batchId ?? null;
  }
  segment.reasoningMs = reasoningMsFromMessage(message);
  return segment;
}

// The last assistant message in a thread is the live/recent turn; earlier
// messages are settled transcript already served by the REST read.
export function lastAssistantMessage(messages: readonly UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i]!;
  }
  return undefined;
}

// LX-120: the suspension must be projected from the merged carrier set across
// the trailing turn, not from the last assistant message alone. The DO attaches
// the carrier to the message that held the write proposals (withApprovalCarriers),
// so a later text-only assistant message in the same turn hides it; and a
// marker-only carrier (empty approvals) carries no reconstructable chip. A batch
// is suspended when its merged chips hold a pending one, or its carrier was
// marker-only; a fully-terminal batch (decided in another tab) never re-arms.
// Terminal decisions win by approvalId, mirroring `mergeBatchChips`' union.
export function suspensionFromMessages(
  messages: readonly UIMessage[]
): { pending: AssistantPendingChip[]; suspendedBatchId: string | null } {
  // Trailing region only: assistant messages after the newest user turn. An
  // older turn's marker must not keep the current turn suspended.
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }

  const byApproval = new Map<string, AssistantPendingChip>();
  const batchOrder: string[] = [];
  const seenBatches = new Set<string>();
  const noteBatch = (batchId: string) => {
    if (!seenBatches.has(batchId)) {
      seenBatches.add(batchId);
      batchOrder.push(batchId);
    }
  };
  // Terminal-wins across carriers: a pending incoming chip must never replace
  // an already-terminal chip (a stale proposal carrier must not re-arm a batch
  // decided elsewhere), while between two terminal chips the later arrival is
  // the newer decision. Getting this wrong leaves the batch suspended and the
  // UI POSTs `/resume` for a batch that already executed.
  const isTerminal = (chip: AssistantPendingChip) => (chip.state ?? "pending") !== "pending";
  const mergeChip = (chip: AssistantPendingChip) => {
    noteBatch(chip.batchId);
    const existing = byApproval.get(chip.approvalId);
    if (existing && isTerminal(existing) && !isTerminal(chip)) return;
    byApproval.set(chip.approvalId, chip);
  };

  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type.startsWith("data-")) {
        const carrier = carrierFromDataPart(part.type, (part as { data?: unknown }).data);
        if (!carrier) continue;
        noteBatch(carrier.batchId);
        for (const chip of carrier.chips) mergeChip(chip);
        continue;
      }
      if (!isAssistantToolPart(part)) continue;
      const chip = chipFromToolOutput(part, getToolName(part));
      if (chip) mergeChip(chip);
    }
  }

  let suspendedBatchId: string | null = null;
  for (let i = batchOrder.length - 1; i >= 0; i--) {
    const batchId = batchOrder[i]!;
    let hasChip = false;
    let hasPending = false;
    for (const chip of byApproval.values()) {
      if (chip.batchId !== batchId) continue;
      hasChip = true;
      if ((chip.state ?? "pending") === "pending") {
        hasPending = true;
        break;
      }
    }
    if (!hasChip || hasPending) {
      suspendedBatchId = batchId;
      break;
    }
  }

  const pending = [...byApproval.values()].sort((a, b) => a.seq - b.seq);
  return { pending, suspendedBatchId };
}

// The last-assistant full projection (text/tools/citations/usage) with the
// suspension overridden by the merged carrier set across the trailing turn.
export function segmentFromMessages(messages: readonly UIMessage[]): AgentSegment {
  const segment = segmentFromAssistantMessage(lastAssistantMessage(messages));
  const { pending, suspendedBatchId } = suspensionFromMessages(messages);
  segment.pending = pending;
  segment.suspendedBatchId = suspendedBatchId;
  return segment;
}

export function hasUserMessage(messages: readonly UIMessage[]): boolean {
  return messages.some((m) => m.role === "user");
}

export function statusFromChat(status: ChatStatus, segment: AgentSegment, error: Error | undefined): AssistantStreamStatus {
  if (status === "error" || error) return "error";
  if (segment.suspendedBatchId !== null) return "suspended";
  if (status === "submitted") return "connecting";
  if (status === "streaming") return segment.hasIngress ? "streaming" : "connecting";
  // ready
  return segment.hasIngress ? "done" : "idle";
}

export interface AgentSnapshotOptions {
  status: ChatStatus;
  error: Error | undefined;
  // Terminal transport failure from the agent socket (the SDK exposes it as
  // `connectionError`). Distinct from `error` so the snapshot can surface it as
  // a failed turn instead of silently idling on a dead socket.
  connectionError?: Error | null | undefined;
  recovering?: boolean;
  usage?: { in: number; out: number } | null;
}

// Fold the adapter segment + the SDK chat status into the legacy snapshot
// shape. `frames` stays empty (transport-only); `usage` rides message metadata
// when the server provides it.
export function snapshotFromSegment(segment: AgentSegment, options: AgentSnapshotOptions): AssistantStreamSnapshot {
  const connectionError = options.connectionError ?? null;
  const error = options.error ?? connectionError ?? undefined;
  const status = statusFromChat(options.status, segment, error);
  const snapshotError =
    status === "error"
      ? options.error
        ? {
            code: (options.error as { code?: string } | undefined)?.code ?? "ASSISTANT_GENERATION_FAILED",
            message: options.error.message || "Assistant generation failed",
          }
        : connectionError
          ? {
              code: "ASSISTANT_CONNECTION_LOST",
              message: connectionError.message || "The connection to the assistant was lost.",
            }
          : null
      : null;
  return {
    status,
    frames: [],
    text: segment.text,
    tools: segment.tools,
    items: segment.items,
    reasoningText: segment.reasoningText,
    reasoningActive: false,
    reasoningMs: segment.reasoningMs,
    pending: segment.pending,
    suspendedBatchId: segment.suspendedBatchId,
    error: snapshotError,
    usage: options.usage ?? null,
    hasIngress: segment.hasIngress,
  };
}

// Inverse mapping for sends: the legacy chat body → the AI SDK user message.
// Attachments ride as data parts (storage refs, hydrated server-side) plus the
// `body` request metadata the DO reads from `onChatMessage` options.
export interface AgentSendBody {
  projectId?: string | undefined;
  chatId?: string | undefined;
  message?: string | undefined;
  attachments?: Array<{ storageKey: string; mimeType: string; name: string }> | undefined;
  fromIndex?: number | undefined;
  reasoningEffort?: string | undefined;
  // Per-thread WRITE-tool permission mode carried on the send envelope (D2).
  permissionMode?: AssistantToolPermissionMode | undefined;
}

export function agentSendParts(body: AgentSendBody): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  if (typeof body.message === "string" && body.message.length > 0) parts.push({ type: "text", text: body.message });
  for (const attachment of body.attachments ?? []) {
    parts.push({
      type: "data-attachment",
      data: { storageKey: attachment.storageKey, mimeType: attachment.mimeType, name: attachment.name },
    });
  }
  return parts;
}

// The request-level metadata the server reads from the chat request body
// (project scope, effort override, edit/regenerate fork index).
export function agentSendMetadata(body: AgentSendBody): Record<string, unknown> {
  return {
    ...(body.projectId ? { projectId: body.projectId } : {}),
    ...(body.chatId ? { chatId: body.chatId } : {}),
    ...(body.fromIndex !== undefined ? { fromIndex: body.fromIndex } : {}),
    ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    ...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
  };
}
