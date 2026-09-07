import type { ApprovalChip } from "./HeraldApprovals";
import type { HeraldTimelineItem, HeraldToolChip } from "../../lib/use-herald-stream";

// Pure helpers + wire-shape types for Herald chat (herald-chat.html +
// herald-chat-upgrades.html).

export interface CitationView {
  url: string;
  title: string | null;
  hostname: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  imageCount: number;
  // Index into the RAW transcript messages array — resend targets are raw
  // positions (the server truncates its own array).
  rawIndex: number;
  ts?: string | undefined;
  citations?: CitationView[];
  error?: { code: string; message: string };
  stopped?: boolean | undefined;
  // Post-stream activity snapshot frozen at suspend time (session memory).
  activity?: ActivityView | undefined;
  // Frozen write-approval batch (herald-write-approvals.html): chips live in
  // session memory from the tool_pending frames; decisions mutate them here.
  batch?: { batchId: string; chips: ApprovalChip[] };
  // Reload mid-suspension: the transcript entry carries the pendingBatch
  // marker but NOT the chip payloads (no batch-read endpoint) — render the
  // waiting indicator only.
  suspendedBatchId?: string | undefined;
}

// Post-stream activity summary shown on the trailing done turn — sourced from
// the live stream session's memory only; transcript-loaded turns never get
// one (reasoning is never persisted).
export interface ActivityView {
  items: HeraldTimelineItem[];
  tools: HeraldToolChip[];
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
// (herald-chat-upgrades.html FAILED section):
// - PROVIDER_AUTH_FAILED → link chip to Project Settings → Herald
// - HERALD_TOOL_BUDGET_EXCEEDED → informational only
// - PROVIDER_UNREACHABLE / rate-limit family → prominent Retry
export type ErrorGuidance = "settings" | "info" | "retry";

export function guidanceFor(code: string): ErrorGuidance {
  if (code === "PROVIDER_AUTH_FAILED") return "settings";
  if (/RATE|UNREACHABLE|GENERATION_FAILED/.test(code)) return "retry";
  return "info";
}

export const GUIDANCE_BODY: Record<string, string> = {
  PROVIDER_AUTH_FAILED: "The provider rejected the configured API key. Nothing was added to the thread.",
  HERALD_TOOL_BUDGET_EXCEEDED:
    "The reply hit its tool-call budget before finishing. Narrow the ask or raise the budget in project settings to let Herald go further.",
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

export function hhmm(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
      ts?: unknown;
      citations?: unknown;
      error?: unknown;
      stopped?: unknown;
      pendingBatch?: unknown;
    };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    let text = "";
    let imageCount = 0;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string | undefined; content?: unknown; text?: unknown }>) {
        if (part.type === "image-ref") imageCount++;
        else text += String(part.content ?? part.text ?? "");
      }
    }
    // Suspended-turn marker (legacy string batchId or PendingBatchMarker
    // object) — chip payloads are NOT in the transcript; the waiting
    // indicator renders without them.
    const pendingBatchId =
      typeof msg.pendingBatch === "string"
        ? msg.pendingBatch
        : msg.pendingBatch && typeof msg.pendingBatch === "object" &&
            typeof (msg.pendingBatch as { batchId?: unknown }).batchId === "string"
          ? (msg.pendingBatch as { batchId: string }).batchId
          : null;
    if (!text && !imageCount && !msg.error && !msg.stopped && pendingBatchId === null) continue;
    const citations = msg.role === "assistant" ? safeCitations(msg.citations) : [];
    const err = isErrorMeta(msg.error);
    out.push({
      role: msg.role,
      text,
      imageCount,
      rawIndex,
      ...(typeof msg.ts === "string" ? { ts: msg.ts } : {}),
      ...(citations.length > 0 ? { citations } : {}),
      ...(err ? { error: err } : {}),
      ...(msg.stopped === true ? { stopped: true } : {}),
      ...(pendingBatchId !== null ? { suspendedBatchId: pendingBatchId } : {}),
    });
  }
  return out;
}
