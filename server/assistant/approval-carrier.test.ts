import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { ASSISTANT_APPROVAL_DATA_PART, type AssistantWriteDiff } from "../../shared/assistant";
import {
  approvalCarriersOf,
  carrierBatchIds,
  reconcileApprovalCarriers,
  withApprovalCarriers,
} from "./approval-carrier";

const DIFF: AssistantWriteDiff = { type: "task_create", title: "Write docs", fields: { priority: "high" } };

function assistantTurn(proposal: Record<string, unknown>): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "I can do that." },
      {
        type: "tool-create_task",
        toolCallId: "call_1",
        state: "output-available",
        input: {},
        output: proposal,
      },
    ],
  } as unknown as UIMessage;
}

function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposed: true,
    approvalId: "w1",
    batchId: "b1",
    seq: 0,
    name: "create_task",
    detail: "Create “Write docs”",
    diff: DIFF,
    ...over,
  };
}

describe("approval carrier round-trip", () => {
  it("appends a data part to a write-proposal assistant message and reads it back", () => {
    const [withCarrier] = withApprovalCarriers([assistantTurn(proposal())]);
    const carriers = approvalCarriersOf(withCarrier);

    expect(carriers).toEqual([
      {
        batchId: "b1",
        approvals: [
          {
            approvalId: "w1",
            seq: 0,
            name: "create_task",
            detail: "Create “Write docs”",
            diff: DIFF,
          },
        ],
      },
    ]);
    expect((withCarrier!.parts.at(-1) as { type?: string }).type).toBe(ASSISTANT_APPROVAL_DATA_PART);
  });

  it("is idempotent — a message already carrying the part is returned untouched", () => {
    const first = withApprovalCarriers([assistantTurn(proposal())]);
    const second = withApprovalCarriers(first);

    expect(second).toBe(first);
    expect((first[0]!.parts as unknown[]).filter((p) => (p as { type?: string }).type === ASSISTANT_APPROVAL_DATA_PART)).toHaveLength(1);
  });

  it("omits approval fields the proposal lacks (optional diff/detail) without dropping the chip", () => {
    const [withCarrier] = withApprovalCarriers([
      assistantTurn(proposal({ detail: undefined, diff: undefined })),
    ]);
    const approvals = approvalCarriersOf(withCarrier)[0]!.approvals;

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ approvalId: "w1", seq: 0, name: "create_task" });
    expect(approvals[0]).not.toHaveProperty("diff");
    expect(approvals[0]).not.toHaveProperty("detail");
  });

  it("ignores non-proposal tool outputs and non-assistant messages", () => {
    const message = assistantTurn({ proposed: false, approvalId: "w1", batchId: "b1" });
    expect(withApprovalCarriers([message])).toEqual([message]);
    expect(carrierBatchIds([{ role: "user", parts: [{ type: "text", text: "hi" }] }])).toEqual([]);
  });

  it("reports every batchId across a transcript, oldest first, deduped", () => {
    const [first] = withApprovalCarriers([
      assistantTurn(proposal()),
      assistantTurn(proposal({ approvalId: "w2", batchId: "b1", seq: 1 })),
    ]);
    const [second] = withApprovalCarriers([assistantTurn(proposal({ approvalId: "w3", batchId: "b2" }))]);

    expect(carrierBatchIds([first!, second!])).toEqual(["b1", "b2"]);
  });
});

describe("reconcileApprovalCarriers", () => {
  it("applies the live decision status to the matching approval", () => {
    const [withCarrier] = withApprovalCarriers([assistantTurn(proposal())]);
    const reconciled = reconcileApprovalCarriers([withCarrier], [
      { id: "w1", batchId: "b1", status: "approved", seq: 0, name: "create_task", diff: DIFF },
    ]);

    expect(approvalCarriersOf(reconciled[0])[0]!.approvals[0]!.status).toBe("approved");
  });

  it("backfills a marker-only carrier from its decision rows", () => {
    const markerOnly = {
      role: "assistant",
      parts: [{ type: ASSISTANT_APPROVAL_DATA_PART, data: { batchId: "b1", approvals: [] } }],
    };
    const reconciled = reconcileApprovalCarriers([markerOnly], [
      { id: "w1", batchId: "b1", status: "pending", seq: 0, name: "create_task", diff: DIFF },
    ]);

    expect(approvalCarriersOf(reconciled[0])).toEqual([
      {
        batchId: "b1",
        approvals: [{ approvalId: "w1", seq: 0, name: "create_task", status: "pending", diff: DIFF }],
      },
    ]);
  });

  it("returns the transcript untouched when there are no decision rows", () => {
    const [withCarrier] = withApprovalCarriers([assistantTurn(proposal())]);
    expect(reconcileApprovalCarriers([withCarrier], [])).toBeInstanceOf(Array);
    const input = [withCarrier];
    expect(reconcileApprovalCarriers(input, [])).toBe(input);
  });
});
