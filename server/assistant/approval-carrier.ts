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
  ASSISTANT_CONTINUATION_DATA_PART,
  type AssistantApprovalCarrier,
  type AssistantApprovalCarrierApproval,
  type AssistantContinuationBoundary,
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
  proposedByRunId?: unknown;
  status?: unknown;
}

function approvalFromProposal(output: ProposalOutput, fallbackName: string): AssistantApprovalCarrierApproval | null {
  const approvalId = readString(output, "approvalId");
  if (!approvalId) return null;
  const seq = readSeq(output.seq) ?? 0;
  const name = readString(output, "name") ?? fallbackName;
  const detail = readString(output, "detail");
  const proposedByRunId = readString(output, "proposedByRunId");
  const status = output.status;
  return {
    approvalId,
    seq,
    name,
    ...(detail ? { detail } : {}),
    ...(output.diff !== undefined ? { diff: output.diff as AssistantWriteDiff } : {}),
    ...(proposedByRunId ? { proposedByRunId } : {}),
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
      const proposedByRunId = readString(entry, "proposedByRunId");
      const status = entry.status;
      parsed.push({
        approvalId,
        seq,
        name,
        ...(detail ? { detail } : {}),
        ...(entry.diff !== undefined ? { diff: entry.diff as AssistantWriteDiff } : {}),
        ...(proposedByRunId ? { proposedByRunId } : {}),
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

/** True when the message carries the `data-assistant-approval` carrier for `batchId`. */
export function messageCarriesBatch(message: unknown, batchId: string): boolean {
  return approvalCarriersOf(message).some((carrier) => carrier.batchId === batchId);
}

/** Every resumed batchId already carrying a continuation boundary, deduped. */
export function continuationBoundaryBatchIds(messages: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const raw of message.parts) {
      if (!isRecord(raw) || raw.type !== ASSISTANT_CONTINUATION_DATA_PART) continue;
      const batchId = isRecord(raw.data) ? readString(raw.data, "batchId") : undefined;
      if (batchId && !out.includes(batchId)) out.push(batchId);
    }
  }
  return out;
}

// The SDK's `continuation: true` clone of the last assistant message appends the
// resume parts AFTER every pre-existing part, and `withApprovalCarriers` always
// appends its carrier(s) last — so a message carrying an approval carrier with
// parts after that carrier is a continuation clone. This is the STRUCTURAL seam:
// no in-memory resume signal is needed, so an unrelated persist cannot consume
// or move it and a fresh DO instance (post-eviction SDK recovery) still splits.
//
// Multiple carriers are kept together in the proposal bubble (the seam is after
// the last carrier) and the boundary names the last carrier's batch. A
// continuation that re-proposes writes has no carrier yet at split time — the
// transform runs before `withApprovalCarriers` — so its new proposal stays in
// the continuation bubble and receives its own carrier afterwards.
function continuationSeam(parts: readonly unknown[]): { seam: number; batchId: string } | null {
  let lastCarrier = -1;
  let batchId: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as { type?: unknown; data?: unknown } | null;
    if (!isRecord(part) || part.type !== ASSISTANT_APPROVAL_DATA_PART) continue;
    const id = isRecord(part.data) ? readString(part.data, "batchId") : undefined;
    if (!id) continue;
    lastCarrier = i;
    batchId = id;
  }
  if (lastCarrier < 0 || lastCarrier >= parts.length - 1 || !batchId) return null;
  return { seam: lastCarrier + 1, batchId };
}

/**
 * LX-124 persist-time transform: split a resume continuation off the proposal
 * message the SDK clones it onto, and mark the seam with a zero-text
 * `data-continuation` boundary message. The SDK reuses the proposal message's id
 * for the continuation, so without a split the follow-up renders inside the
 * proposal bubble; this preserves the proposal bubble (id unchanged, carrier
 * intact) and persists the appended parts as a NEW assistant message, with the
 * boundary immediately before it.
 *
 * Structural: a message that carries a carrier AND has parts after it splits,
 * whether or not the DO holds an in-memory resume signal — so a repaired or
 * `onRunFinished` persist with no post-seam parts is left untouched, and a
 * combined persist re-driven on a fresh instance still splits. Idempotent: a
 * batch already carrying a `data-continuation` boundary is skipped, so a
 * replayed resume never duplicates the marker. Runs on the incoming array
 * BEFORE `withApprovalCarriers`, so a newly-derived carrier cannot move the
 * seam to the end of the message.
 */
export function withContinuationBoundary(messages: UIMessage[]): UIMessage[] {
  const marked = new Set(continuationBoundaryBatchIds(messages));
  const out: UIMessage[] = [];
  let touched = false;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) {
      out.push(message);
      continue;
    }
    const seam = continuationSeam(message.parts);
    if (!seam || marked.has(seam.batchId)) {
      out.push(message);
      continue;
    }
    const boundary: UIMessage = {
      id: `${message.id}~boundary~${seam.batchId}`,
      role: "assistant",
      parts: [
        {
          type: ASSISTANT_CONTINUATION_DATA_PART,
          data: { batchId: seam.batchId, ts: new Date().toISOString() } satisfies AssistantContinuationBoundary,
        } as unknown as UIMessage["parts"][number],
      ],
    };
    out.push(
      { ...message, parts: message.parts.slice(0, seam.seam) },
      boundary,
      { ...message, id: `${message.id}~cont~${seam.batchId}`, parts: message.parts.slice(seam.seam) }
    );
    marked.add(seam.batchId);
    touched = true;
  }
  return touched ? out : messages;
}

/** One decision row as read from `assistant_pending_writes`. */
export interface CarrierDecisionRow {
  id: string;
  batchId?: string | undefined;
  status: ApprovalStatus;
  seq?: number | undefined;
  name?: string | undefined;
  diff?: unknown;
  proposedByRunId?: string | undefined;
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
            ...(row.proposedByRunId ? { proposedByRunId: row.proposedByRunId } : {}),
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
        if ((a as { proposedByRunId?: unknown }).proposedByRunId === undefined && row.proposedByRunId) {
          patch.proposedByRunId = row.proposedByRunId;
        }
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
