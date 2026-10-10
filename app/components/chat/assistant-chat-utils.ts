import type { UIMessage } from "ai";
import { ASSISTANT_APPROVAL_DATA_PART, type AssistantWriteDiff } from "../../../shared/assistant";
import type { ApprovalChip } from "./AssistantApprovals";
import type { AssistantTimelineItem, AssistantToolChip } from "../../lib/use-assistant-stream";
import { segmentFromAssistantMessage } from "../../lib/assistant-agent-adapter";
import { extractSpawnedRuns, type SpawnedRunRef } from "../../lib/assistant-run-adapter";
import type { ChatAttachmentKind, ChatAttachmentRef } from "../../lib/assistant-image";

// Pure helpers + wire-shape types for Assistant chat (assistant-chat.html +
// assistant-chat-upgrades.html).

export interface CitationView {
  url: string;
  title: string | null;
  hostname: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  imageCount: number;
  // Persisted attachment refs for a user turn (LX-2) — replayed by retry /
  // regenerate (D6) and rendered as thumbnails / document chips. Optimistic
  // turns carry previewUrl/sizeBytes too.
  attachments?: ChatAttachmentRef[] | undefined;
  // Index into the RAW transcript messages array — resend targets are raw
  // positions (the server truncates its own array).
  rawIndex: number;
  ts?: string | undefined;
  citations?: CitationView[];
  error?: { code: string; message: string };
  stopped?: boolean | undefined;
  // Post-stream activity snapshot frozen at suspend time (session memory).
  activity?: ActivityView | undefined;
  // Frozen write-approval batch (assistant-write-approvals.html): chips live in
  // session memory from the tool_pending frames; decisions mutate them here.
  // Reload mid-suspension rebuilds the chips from the persisted pendingBatch
  // marker (assistant-write-approvals.html: "chips + waiting indicator are
  // persisted state"), so the same batch is decidable after a reload.
  batch?: { batchId: string; chips: ApprovalChip[] };
  // Legacy pendingBatch markers (or entries persisted before chip payloads
  // existed) carry no reconstructable chips — render the waiting indicator
  // only. New suspensions carry the full approvals payload and render chips.
  suspendedBatchId?: string | undefined;
  // Delegated runs this assistant turn spawned (ADR-0004) — each renders a run
  // card as a sibling AFTER the bubble, keyed by `toolCallId`. Durable: rebuilt
  // from the persisted `spawn_run` tool parts on every transcript read.
  spawnedRuns?: SpawnedRunRef[] | undefined;
}

// A persisted pendingBatch approval rebuilds into a decidable chip only when it
// carries the full payload (seq/name/diff); older markers yield null and fall
// back to the marker-only waiting indicator.
export function chipFromPendingApproval(raw: unknown, batchId: string): ApprovalChip | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { approvalId?: unknown; seq?: unknown; name?: unknown; detail?: unknown; diff?: unknown; status?: unknown };
  if (typeof a.approvalId !== "string" || a.approvalId === "") return null;
  if (typeof a.name !== "string" || a.name === "") return null;
  if (typeof a.seq !== "number" || !Number.isFinite(a.seq)) return null;
  if (!a.diff || typeof a.diff !== "object") return null;
  // A reconciled status (another tab decided this approval) renders the chip
  // terminal instead of pending.
  const state: ApprovalChip["state"] =
    a.status === "approved" || a.status === "rejected" || a.status === "expired" ? a.status : "pending";
  return {
    approvalId: a.approvalId,
    batchId,
    seq: a.seq,
    name: a.name,
    ...(typeof a.detail === "string" && a.detail !== "" ? { detail: a.detail } : {}),
    diff: a.diff as AssistantWriteDiff,
    state,
  };
}

// D3 (W7b/WS2): the persisted pending-batch carrier is a
// `data-assistant-approval` part shaped `{ batchId, approvals[] }` (or a single
// chip payload). Rebuild the batch from it — an empty `approvals` array keeps
// the batchId so a marker-only carrier still renders the waiting indicator.
function carrierBatchOf(parts: readonly unknown[]): { batchId: string; chips: ApprovalChip[] } | undefined {
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as { type?: unknown; data?: unknown };
    if (part.type !== ASSISTANT_APPROVAL_DATA_PART) continue;
    const data = part.data;
    if (!data || typeof data !== "object") continue;
    const envelope = data as { batchId?: unknown; approvals?: unknown };
    if (typeof envelope.batchId !== "string" || envelope.batchId === "") continue;
    const rawApprovals = Array.isArray(envelope.approvals) ? envelope.approvals : [data];
    const chips = rawApprovals
      .map((a) => chipFromPendingApproval(a, envelope.batchId as string))
      .filter((c): c is ApprovalChip => c !== null);
    return { batchId: envelope.batchId, chips };
  }
  return undefined;
}

// Post-stream activity summary shown on a settled turn — sourced from the live
// stream session's memory, or rebuilt from a persisted reasoning part +
// `metadata.reasoningMs` on a transcript-loaded turn.
export interface ActivityView {
  items: AssistantTimelineItem[];
  tools: AssistantToolChip[];
  reasoningMs: number | null;
}

// HTTPS-ONLY: http:// sources never render as chips (mixed-content +
// spoofing discipline) — they stay out of the chip row entirely.
export function safeCitations(raw: unknown): CitationView[] {
  if (!Array.isArray(raw)) return [];
  const out: CitationView[] = [];
  for (const entry of raw) {
    const c = entry as { url?: unknown; title?: unknown };
    if (typeof c.url !== "string" || !/^https:\/\//i.test(c.url)) continue;
    let hostname = "";
    try {
      hostname = new URL(c.url).hostname;
    } catch {
      continue;
    }
    out.push({ url: c.url, title: typeof c.title === "string" ? c.title : null, hostname });
  }
  return out;
}

// Code-aware guidance map for persisted error entries
// (assistant-chat-upgrades.html FAILED section):
// - PROVIDER_AUTH_FAILED → link chip to Project Settings → Assistant
// - ASSISTANT_TOOL_BUDGET_EXCEEDED → informational only
// - PROVIDER_UNREACHABLE / rate-limit family → prominent Retry
export type ErrorGuidance = "settings" | "info" | "retry";

export function guidanceFor(code: string): ErrorGuidance {
  if (code === "PROVIDER_AUTH_FAILED") return "settings";
  if (/RATE|UNREACHABLE|GENERATION_FAILED/.test(code)) return "retry";
  return "info";
}

export const GUIDANCE_BODY: Record<string, string> = {
  PROVIDER_AUTH_FAILED: "The provider rejected the configured API key. Nothing was added to the thread.",
  ASSISTANT_TOOL_BUDGET_EXCEEDED:
    "The reply hit its tool-call budget before finishing. Narrow the ask or raise the budget in project settings to let Assistant go further.",
  PROVIDER_UNREACHABLE: "The provider closed the stream unexpectedly (rate limit or outage). Nothing was added to the thread.",
};

// Split stored text on ``` fences → plain / fenced segments. Fenced bodies
// render as a highlighted mono block with a language label + copy button.
export function splitFences(text: string): { fenced: boolean; body: string; lang?: string }[] {
  const parts = text.split("```");
  const out: { fenced: boolean; body: string; lang?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const body = parts[i]!;
    if (i % 2 === 0) {
      if (body.length > 0) out.push({ fenced: false, body });
      continue;
    }
    const m = body.match(/^([a-zA-Z0-9_-]*)\n/);
    const lang = m && m[1] ? m[1] : undefined;
    const fencedBody = m ? body.slice(m[0].length) : body;
    if (fencedBody.length > 0) out.push({ fenced: true, body: fencedBody, ...(lang ? { lang } : {}) });
  }
  return out;
}

// Image vs document from the stored mime (image/* → image, everything else is
// a document ref).
export function refKind(mimeType: string): ChatAttachmentKind {
  return mimeType.startsWith("image/") ? "image" : "document";
}

export function hhmm(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The suspended batch is the NEWEST turn, so `Review ↑` and proposal-arrival
// targeting use the LAST `.approval-batch` in the scroll container — not the
// first one rendered. Lives here (not in the composer) so the auto-scroll hook
// and the composer share one definition.
export function lastApprovalBatch(root: ParentNode): Element | null {
  const batches = root.querySelectorAll(".approval-batch");
  return batches.length > 0 ? batches[batches.length - 1]! : null;
}

function isErrorMeta(raw: unknown): { code: string; message: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as { code?: unknown; message?: unknown };
  if (typeof e.code !== "string" || !e.code) return undefined;
  return { code: e.code, message: typeof e.message === "string" ? e.message : "" };
}

// ModelMessage JSON → display turns. Text parts carry their payload in
// `content` (server wire shape); plain string content is the common case.
// Optional inline meta (ts / citations / error / stopped) is read
// defensively — legacy entries lack all of it. rawIndex preserves the
// position in the RAW messages array for resend targeting.
export function renderTranscript(messages: unknown[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (let rawIndex = 0; rawIndex < messages.length; rawIndex++) {
    const msg = messages[rawIndex] as {
      role?: string | undefined;
      content?: unknown;
      parts?: unknown;
      metadata?: unknown;
      ts?: unknown;
      citations?: unknown;
      error?: unknown;
      stopped?: unknown;
      pendingBatch?: unknown;
    };
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    // D3 (W7b/WS2): the DO canonical transcript is UIMessage-parts shaped.
    // Reuse the P4b adapter for text/citations and rebuild the approval batch
    // from the `data-assistant-approval` carrier data part.
    if (Array.isArray(msg.parts)) {
      const parts = msg.parts as unknown[];
      const segment = msg.role === "assistant" ? segmentFromAssistantMessage(msg as unknown as UIMessage) : undefined;
      let text = "";
      let imageCount = 0;
      const attachments: ChatAttachmentRef[] = [];
      for (const raw of parts) {
        if (!raw || typeof raw !== "object") continue;
        const part = raw as { type?: unknown; text?: unknown; data?: unknown };
        if (part.type === "text" && typeof part.text === "string") {
          text += part.text;
          continue;
        }
        if (part.type === "data-attachment" && part.data && typeof part.data === "object") {
          const d = part.data as { storageKey?: unknown; mimeType?: unknown; name?: unknown };
          if (typeof d.storageKey !== "string") continue;
          const mimeType = typeof d.mimeType === "string" ? d.mimeType : "text/plain";
          attachments.push({ storageKey: d.storageKey, mimeType, name: typeof d.name === "string" ? d.name : "" });
          if (refKind(mimeType) === "image") imageCount++;
        }
      }
      const metadata = ((msg.metadata ?? {}) as { ts?: unknown; citations?: unknown; error?: unknown; stopped?: unknown });
      const carrier = carrierBatchOf(parts);
      // A run can be spawned with no assistant text of its own — the card must
      // still render, so a spawn ref keeps an otherwise-empty turn alive.
      const spawnedRuns = msg.role === "assistant" ? extractSpawnedRuns([msg]) : [];
      if (!text && !imageCount && !metadata.error && metadata.stopped !== true && !carrier && spawnedRuns.length === 0) continue;
      const citations =
        msg.role === "assistant"
          ? safeCitations([
              ...(Array.isArray(metadata.citations) ? metadata.citations : []),
              ...(segment?.citations ?? []).map((c) => ({ url: c.url, title: c.title })),
            ])
          : [];
      // Reload-visible reasoning fold: a persisted reasoning part + metadata
      // duration rebuild the done-fold activity a live stream would have frozen
      // in session memory. Tool parts stay session-memory-only, so this only
      // attaches when reasoning is actually present.
      const activity =
        segment && msg.role === "assistant" && (segment.reasoningText !== "" || segment.reasoningMs !== null)
          ? { items: segment.items, tools: segment.tools, reasoningMs: segment.reasoningMs }
          : undefined;
      const err = isErrorMeta(metadata.error);
      out.push({
        role: msg.role,
        text,
        imageCount,
        rawIndex,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(typeof metadata.ts === "string" ? { ts: metadata.ts } : {}),
        ...(citations.length > 0 ? { citations } : {}),
        ...(err ? { error: err } : {}),
        ...(metadata.stopped === true ? { stopped: true } : {}),
        ...(activity ? { activity } : {}),
        ...(spawnedRuns.length > 0 ? { spawnedRuns } : {}),
        ...(carrier
          ? carrier.chips.length > 0
            ? { batch: carrier }
            : { suspendedBatchId: carrier.batchId }
          : {}),
      });
      continue;
    }

    let text = "";
    let imageCount = 0;
    const attachments: ChatAttachmentRef[] = [];
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string | undefined; content?: unknown; text?: unknown; storageKey?: unknown; mimeType?: unknown; name?: unknown }>) {
        if ((part.type === "image-ref" || part.type === "image") && typeof part.storageKey === "string") {
          attachments.push({ storageKey: part.storageKey, mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png", name: typeof part.name === "string" ? part.name : "" });
          imageCount++;
        } else if (part.type === "document-ref" && typeof part.storageKey === "string") {
          attachments.push({ storageKey: part.storageKey, mimeType: typeof part.mimeType === "string" ? part.mimeType : "text/plain", name: typeof part.name === "string" ? part.name : "" });
        } else {
          text += String(part.content ?? part.text ?? "");
        }
      }
    }
    // Suspended-turn marker (legacy string batchId or PendingBatchMarker
    // object). When the marker carries the full approvals payload the chips
    // are rebuilt so a reload mid-approval is decidable; otherwise the waiting
    // indicator renders without them.
    const pendingBatchId =
      typeof msg.pendingBatch === "string"
        ? msg.pendingBatch
        : msg.pendingBatch && typeof msg.pendingBatch === "object" &&
            typeof (msg.pendingBatch as { batchId?: unknown }).batchId === "string"
          ? (msg.pendingBatch as { batchId: string }).batchId
          : null;
    if (!text && !imageCount && !msg.error && !msg.stopped && pendingBatchId === null) continue;
    let batch: { batchId: string; chips: ApprovalChip[] } | undefined;
    let suspendedBatchId: string | undefined;
    if (pendingBatchId !== null) {
      const rawApprovals = (msg.pendingBatch as { approvals?: unknown }).approvals;
      const chips = Array.isArray(rawApprovals)
        ? rawApprovals.map((a) => chipFromPendingApproval(a, pendingBatchId)).filter((c): c is ApprovalChip => c !== null)
        : [];
      if (chips.length > 0) batch = { batchId: pendingBatchId, chips };
      else suspendedBatchId = pendingBatchId;
    }
    const citations = msg.role === "assistant" ? safeCitations(msg.citations) : [];
    const err = isErrorMeta(msg.error);
    out.push({
      role: msg.role,
      text,
      imageCount,
      rawIndex,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(typeof msg.ts === "string" ? { ts: msg.ts } : {}),
      ...(citations.length > 0 ? { citations } : {}),
      ...(err ? { error: err } : {}),
      ...(msg.stopped === true ? { stopped: true } : {}),
      ...(batch ? { batch } : suspendedBatchId !== undefined ? { suspendedBatchId } : {}),
    });
  }
  return out;
}
