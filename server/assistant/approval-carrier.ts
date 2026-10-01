// Pending-batch carrier (ADR-0003 §B.3, W7b/WS1) — the approvals suspend
// marker persisted WITH the assistant UIMessage as a `data-assistant-approval`
// data part, shaped as `{ batchId, approvals[] }` (the envelope the P4b
// adapter's `chipsFromDataPart` already reads).
//
// Why a part and not the legacy `pendingBatch` field: the D3 transcript now
// serves UIMessage parts, where per-message extension fields do not exist.
// Keeping the marker on the message means the DO canonical store and the D1
// mirror both carry it, so a reload mid-suspension rebuilds the decidable
// chips without a separate batch-read endpoint.
//
// Pure module: no Effect, no IO, no runtime deps.

import type { UIMessage } from "ai";
import {
  ASSISTANT_APPROVAL_DATA_PART,
  type AssistantApprovalCarrier,
  type AssistantApprovalCarrierApproval,
  type AssistantWriteDiff,
} from "../../shared/assistant";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A successful write-proposal tool output, as returned by `proposeWrite`. */
interface ProposalOutput {
  [key: string]: unknown;
  proposed?: unknown;
  approvalId?: unknown;
  batchId?: unknown;
  seq?: unknown;
  name?: unknown;
  detail?: unknown;
  diff?: unknown;
  status?: unknown;
}

function approvalFromProposal(output: ProposalOutput, fallbackName: string): AssistantApprovalCarrierApproval | null {
  const approvalId = readString(output, "approvalId");
  if (!approvalId) return null;
  const seq = readSeq(output.seq) ?? 0;
  const name = readString(output, "name") ?? fallbackName;
  const detail = readString(output, "detail");
  const status = output.status;
  return {
    approvalId,
    seq,
    name,
    ...(detail ? { detail } : {}),
    ...(output.diff !== undefined ? { diff: output.diff as AssistantWriteDiff } : {}),
    ...(status === "pending" || status === "approved" || status === "rejected" || status === "expired"
      ? { status }
      : {}),
  } as AssistantApprovalCarrierApproval;
}

/**
 * Build the carrier part(s) for one assistant message from its successful
 * write-proposal tool parts. One part per batchId (a turn mints one batch),
 * approvals in arrival order.
 */
function carriersForMessage(message: UIMessage): AssistantApprovalCarrier[] {
  if (message.role !== "assistant" || !Array.isArray(message.parts)) return [];
  const byBatch = new Map<string, AssistantApprovalCarrierApproval[]>();
  for (const raw of message.parts) {
    const part = raw as { type?: unknown; toolName?: unknown; state?: unknown; output?: unknown };
    if (typeof part.type !== "string" || !part.type.startsWith("tool-")) continue;
    if (part.state !== "output-available" || !isRecord(part.output)) continue;
    const output = part.output as ProposalOutput;
    if (output.proposed !== true) continue;
    const batchId = readString(output, "batchId");
    if (!batchId) continue;
    const fallbackName = typeof part.toolName === "string" ? part.toolName : part.type.slice("tool-".length);
    const approval = approvalFromProposal(output, fallbackName);
    if (!approval) continue;
    const list = byBatch.get(batchId);
    if (list) list.push(approval);
    else byBatch.set(batchId, [approval]);
  }
  return [...byBatch.entries()].map(([batchId, approvals]) => ({ batchId, approvals }));
}

function hasCarrierPart(message: UIMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.parts)) return false;
  return message.parts.some((part) => (part as { type?: unknown }).type === ASSISTANT_APPROVAL_DATA_PART);
}

/**
 * Persist-time transform: append the carrier part to every assistant message
 * that holds write proposals and does not already carry one. Idempotent — a
 * message already holding a carrier is returned untouched, so repeated
 * `persistMessages` calls never duplicate parts.
 */
export function withApprovalCarriers(messages: UIMessage[]): UIMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (hasCarrierPart(message)) return message;
    const carriers = carriersForMessage(message);
    if (carriers.length === 0) return message;
    touched = true;
    const parts = [
      ...message.parts,
      ...carriers.map(
        (data) => ({ type: ASSISTANT_APPROVAL_DATA_PART, data }) as unknown as UIMessage["parts"][number]
      ),
    ];
    return { ...message, parts };
  });
  return touched ? out : messages;
}

/** Every `data-assistant-approval` carrier on one transcript message. */
export function approvalCarriersOf(message: unknown): AssistantApprovalCarrier[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) return [];
  const out: AssistantApprovalCarrier[] = [];
  for (const raw of message.parts) {
    if (!isRecord(raw) || raw.type !== ASSISTANT_APPROVAL_DATA_PART) continue;
    const data = raw.data;
    if (!isRecord(data)) continue;
    const batchId = readString(data, "batchId");
    const approvals = Array.isArray(data.approvals) ? data.approvals : [];
    if (!batchId) continue;
    const parsed: AssistantApprovalCarrierApproval[] = [];
    for (const entry of approvals) {
      if (!isRecord(entry)) continue;
      const approvalId = readString(entry, "approvalId");
      const name = readString(entry, "name");
      if (!approvalId || !name) continue;
      const seq = readSeq(entry.seq) ?? parsed.length;
      const detail = readString(entry, "detail");
      const status = entry.status;
      parsed.push({
        approvalId,
        seq,
        name,
        ...(detail ? { detail } : {}),
        ...(entry.diff !== undefined ? { diff: entry.diff as AssistantWriteDiff } : {}),
        ...(status === "pending" || status === "approved" || status === "rejected" || status === "expired"
          ? { status }
          : {}),
      });
    }
    out.push({ batchId, approvals: parsed });
  }
  return out;
}

/** Every carrier batchId across a transcript, oldest first, deduped. */
export function carrierBatchIds(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    for (const carrier of approvalCarriersOf(message)) {
      if (!out.includes(carrier.batchId)) out.push(carrier.batchId);
    }
  }
  return out;
}

/** One decision row as read from `assistant_pending_writes`. */
export interface CarrierDecisionRow {
  id: string;
  batchId?: string | undefined;
  status: ApprovalStatus;
  seq?: number | undefined;
  name?: string | undefined;
  diff?: unknown;
}

/**
 * Reconcile carrier approvals with live decision rows: matching approvals gain
 * a `status`, and legacy/marker-only carriers (no approvals payload) are
 * backfilled from the decision rows so their chips still rebuild on fetch. A
 * row whose status differs is applied; rows not found keep the persisted
 * shape. Never mutates the input.
 */
export function reconcileApprovalCarriers(
  messages: unknown[],
  rows: ReadonlyArray<CarrierDecisionRow>
): unknown[] {
  if (rows.length === 0) return messages;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rowsByBatch = new Map<string, CarrierDecisionRow[]>();
  for (const row of rows) {
    if (!row.batchId) continue;
    const list = rowsByBatch.get(row.batchId);
    if (list) list.push(row);
    else rowsByBatch.set(row.batchId, [row]);
  }
  let touched = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return message;
    let messageTouched = false;
    const parts = message.parts.map((raw) => {
      if (!isRecord(raw) || raw.type !== ASSISTANT_APPROVAL_DATA_PART) return raw;
      const data = raw.data;
      if (!isRecord(data)) return raw;
      const batchId = readString(data, "batchId");
      if (!batchId) return raw;
      const approvals = Array.isArray(data.approvals) ? (data.approvals as unknown[]) : [];

      // Marker-only carrier: rebuild every approval from the decision rows.
      if (approvals.length === 0) {
        const batchRows = rowsByBatch.get(batchId);
        if (!batchRows || batchRows.length === 0) return raw;
        const rebuilt = batchRows
          .slice()
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
          .map((row) => ({
            approvalId: row.id,
            seq: row.seq ?? 0,
            name: row.name ?? "write",
            status: row.status,
            ...(row.diff !== undefined ? { diff: row.diff } : {}),
          }));
        messageTouched = true;
        return { ...raw, data: { ...data, approvals: rebuilt } };
      }

      let changed = false;
      const nextApprovals = approvals.map((a) => {
        if (!isRecord(a)) return a;
        const id = readString(a, "approvalId");
        if (!id) return a;
        const row = byId.get(id);
        if (!row) return a;
        const patch: Record<string, unknown> = {};
        if (row.status !== a.status) patch.status = row.status;
        if (a.seq === undefined && typeof row.seq === "number") patch.seq = row.seq;
        if (a.name === undefined && typeof row.name === "string") patch.name = row.name;
        if (a.diff === undefined && row.diff !== undefined) patch.diff = row.diff;
        if (Object.keys(patch).length === 0) return a;
        changed = true;
        return { ...a, ...patch };
      });
      if (!changed) return raw;
      messageTouched = true;
      return { ...raw, data: { ...data, approvals: nextApprovals } };
    });
    if (!messageTouched) return message;
    touched = true;
    return { ...message, parts };
  });
  return touched ? next : messages;
}
