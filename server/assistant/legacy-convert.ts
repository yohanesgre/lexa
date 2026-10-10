// Legacy TanStack `ModelMessage[]` → AI SDK `UIMessage[]` conversion (ADR-0003
// §B.3, decision D8). Pure module — no Effect, no IO, no runtime deps — so the
// mapping is unit-testable and can run inside the Durable Object on import.
//
// Mapping contract (fixtures in legacy-convert.test.ts pin it):
//   - `user` / `assistant` / `system` roles convert; `tool` roles and unknown
//     roles are dropped (unmappable tool wire parts).
//   - `content` string → one text part; array parts with a string `content`
//     or `text` → text parts; anything else (image refs etc.) is dropped.
//   - `ts` → `metadata.ts`.
//   - `citations` → `metadata.citations` (sanitized to `{ title, url }`).
//   - `error` → `metadata.error` (`{ code, message }`).
//   - `stopped` → `metadata.stopped` (only when truthy).
//   - `partial` → `metadata.stopped` (a killed turn's in-progress persist; the
//     read renders it as stopped — ADR-0005 §Reliability.3).
//   - `pendingBatch` → a `data-assistant-approval` carrier part (W7b/WS1) so a
//     legacy thread's suspended approvals still rebuild on reload.
//   - `toolLog` / `toolCalls` are NOT mapped (tool detail is session-memory-only
//     by wireframe contract).
// A message always carries at least one part so it survives DO persistence.

import type { UIMessage } from "ai";
import { ASSISTANT_APPROVAL_DATA_PART, type Citation } from "../../shared/assistant";

export interface LegacyStoredMessage {
  role?: unknown;
  content?: unknown;
  ts?: unknown;
  citations?: unknown;
  error?: unknown;
  stopped?: unknown;
  partial?: unknown;
  [key: string]: unknown;
}

export interface LegacyConvertMetadata {
  ts?: string;
  citations?: Citation[];
  error?: { code: string; message: string };
  stopped?: true;
}

export type ConvertedUIMessage = UIMessage<LegacyConvertMetadata>;

type ConvertibleRole = "system" | "user" | "assistant";

function isConvertibleRole(role: unknown): role is ConvertibleRole {
  return role === "system" || role === "user" || role === "assistant";
}

function textFromPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as { type?: unknown; content?: unknown; text?: unknown };
  if (record.type !== undefined && record.type !== "text") return null;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return null;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const part of content) {
      const text = textFromPart(part);
      if (text !== null) out.push(text);
    }
    return out;
  }
  return [];
}

function sanitizeCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const out: Citation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { title?: unknown; url?: unknown };
    if (typeof record.url !== "string" || record.url.length === 0) continue;
    out.push({ title: typeof record.title === "string" ? record.title : null, url: record.url });
  }
  return out;
}

function sanitizeError(value: unknown): { code: string; message: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : "ASSISTANT_GENERATION_FAILED";
  const message = typeof record.message === "string" ? record.message : "Assistant generation failed";
  return { code, message };
}

// W7b/WS1: a legacy assistant `pendingBatch` marker (string batchId or
// `{ batchId, approvals[] }`) converts to the D3 carrier data part so the
// parts-shaped transcript still rebuilds the approvals on reload.
function approvalCarrierPart(
  pendingBatch: unknown
): ConvertedUIMessage["parts"][number] | null {
  if (typeof pendingBatch === "string" && pendingBatch.length > 0) {
    return { type: ASSISTANT_APPROVAL_DATA_PART, data: { batchId: pendingBatch, approvals: [] } } as unknown as ConvertedUIMessage["parts"][number];
  }
  if (typeof pendingBatch !== "object" || pendingBatch === null) return null;
  const batchId = (pendingBatch as { batchId?: unknown }).batchId;
  if (typeof batchId !== "string" || batchId.length === 0) return null;
  const rawApprovals = (pendingBatch as { approvals?: unknown }).approvals;
  const approvals: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawApprovals)) {
    for (const entry of rawApprovals) {
      if (typeof entry !== "object" || entry === null) continue;
      const a = entry as { approvalId?: unknown; seq?: unknown; name?: unknown; detail?: unknown; diff?: unknown; status?: unknown };
      if (typeof a.approvalId !== "string" || a.approvalId.length === 0) continue;
      approvals.push({
        approvalId: a.approvalId,
        seq: typeof a.seq === "number" && Number.isFinite(a.seq) ? a.seq : approvals.length,
        ...(typeof a.name === "string" ? { name: a.name } : {}),
        ...(typeof a.detail === "string" ? { detail: a.detail } : {}),
        ...(a.diff !== undefined ? { diff: a.diff } : {}),
        ...(a.status === "pending" || a.status === "approved" || a.status === "rejected" || a.status === "expired"
          ? { status: a.status }
          : {}),
      });
    }
  }
  return { type: ASSISTANT_APPROVAL_DATA_PART, data: { batchId, approvals } } as unknown as ConvertedUIMessage["parts"][number];
}

export function convertLegacyMessage(message: LegacyStoredMessage, index: number): ConvertedUIMessage | null {
  if (!isConvertibleRole(message.role)) return null;

  const parts: ConvertedUIMessage["parts"] = textParts(message.content).map((text) => ({ type: "text", text }));
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  const carrier = approvalCarrierPart(message.pendingBatch);
  if (carrier) parts.push(carrier);

  const metadata: LegacyConvertMetadata = {};
  if (typeof message.ts === "string" && message.ts.length > 0) metadata.ts = message.ts;
  const citations = sanitizeCitations(message.citations);
  if (citations.length > 0) metadata.citations = citations;
  const error = sanitizeError(message.error);
  if (error) metadata.error = error;
  // A killed turn's in-progress persist (`partial: true`, ADR-0005 §Reliability.3)
  // or its terminal stop persist (`stopped: true`) both render as stopped — the
  // read must surface the marker instead of dropping the partial silently.
  if (message.stopped === true || message.partial === true) metadata.stopped = true;

  const converted: ConvertedUIMessage = {
    id: `legacy-${index}`,
    role: message.role,
    parts,
  };
  if (Object.keys(metadata).length > 0) converted.metadata = metadata;
  return converted;
}

export function convertLegacyMessages(messages: readonly LegacyStoredMessage[]): ConvertedUIMessage[] {
  const out: ConvertedUIMessage[] = [];
  messages.forEach((message, index) => {
    const converted = convertLegacyMessage(message, index);
    if (converted) out.push(converted);
  });
  return out;
}

// D1 `assistant_threads.messages` is parts-shaped on Workers (the mirror stores
// UIMessages) and legacy content-shaped on Bun / pre-migration rows. A row that
// already carries a `parts` array must pass through verbatim — re-converting it
// through {@link convertLegacyMessage} would drop its `data-attachment` and
// `data-assistant-approval` parts. Legacy rows convert as before.
export function convertStoredMessages(messages: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  messages.forEach((message, index) => {
    if (typeof message === "object" && message !== null && Array.isArray((message as { parts?: unknown }).parts)) {
      out.push(message);
      return;
    }
    const converted = convertLegacyMessage(message as LegacyStoredMessage, index);
    if (converted) out.push(converted);
  });
  return out;
}

/**
 * Inverse of {@link convertLegacyMessages} for the P2 REST read path: the DO
 * canonical transcript is UIMessage-parts shaped, but the frontend still speaks
 * the legacy shape until P4 rewrites it (D3 lands the parts shape in P4). Only
 * the fields the forward conversion preserves are reconstructed; tool parts and
 * `id` are dropped (same lossiness as the import, ADR D8).
 *
 * The `data-assistant-approval` carrier (W7b/WS1) is the one extension the
 * forward conversion emits, so it is reconstructed back into `pendingBatch` —
 * otherwise a suspended thread's approvals would be undecidable after the
 * pre-cutover sweep. The last carrier wins (one turn mints one batch).
 */
export function legacyFromUIMessages(messages: readonly unknown[]): LegacyStoredMessage[] {
  const out: LegacyStoredMessage[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; parts?: unknown; metadata?: unknown };
    if (!isConvertibleRole(record.role)) continue;
    const texts: string[] = [];
    let pendingBatch: { batchId: string; approvals: unknown[] } | null = null;
    if (Array.isArray(record.parts)) {
      for (const part of record.parts) {
        if (typeof part !== "object" || part === null) continue;
        const p = part as { type?: unknown; text?: unknown; data?: unknown };
        if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
        if (p.type === ASSISTANT_APPROVAL_DATA_PART) {
          const data = (typeof p.data === "object" && p.data !== null ? p.data : null) as { batchId?: unknown; approvals?: unknown } | null;
          if (data && typeof data.batchId === "string" && data.batchId.length > 0) {
            pendingBatch = { batchId: data.batchId, approvals: Array.isArray(data.approvals) ? data.approvals : [] };
          }
        }
      }
    }
    const legacy: LegacyStoredMessage = { role: record.role, content: texts.join("") };
    const metadata = (typeof record.metadata === "object" && record.metadata !== null ? record.metadata : {}) as LegacyConvertMetadata;
    if (typeof metadata.ts === "string" && metadata.ts.length > 0) legacy.ts = metadata.ts;
    if (Array.isArray(metadata.citations) && metadata.citations.length > 0) legacy.citations = metadata.citations;
    if (metadata.error) legacy.error = metadata.error;
    if (metadata.stopped === true) legacy.stopped = true;
    if (pendingBatch !== null) legacy.pendingBatch = pendingBatch;
    out.push(legacy);
  }
  return out;
}
