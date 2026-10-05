import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { ASSISTANT_APPROVAL_DATA_PART, type AssistantWriteDiff } from "../../shared/assistant";
import {
  approvalCarriersOf,
  carrierBatchIds,
  messageCarriesBatch,
  reconcileApprovalCarriers,
  withApprovalCarriers,
  withContinuationBoundary,
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

describe("withContinuationBoundary — LX-124 continuation split", () => {
  // The SDK's continuation clone appends its parts to the proposal message; the
  // transform must keep the proposal bubble (id + carrier intact) and persist the
  // appended parts as the continuation's own message, with the boundary between.
  function combinedTurn(): UIMessage {
    const [proposalTurn] = withApprovalCarriers([assistantTurn(proposal())]);
    return {
      ...proposalTurn!,
      parts: [
        ...proposalTurn!.parts,
        { type: "step-start" },
        { type: "text", text: "Approved — done.", state: "done" },
      ],
    } as unknown as UIMessage;
  }

  it("splits the continuation into its own message and marks the seam", () => {
    const split = withContinuationBoundary([combinedTurn()]);

    expect(split).toHaveLength(3);
    const [proposalTurn, boundary, continuation] = split;
    // Proposal bubble unchanged: same id, carrier still last.
    expect(proposalTurn!.id).toBe("a1");
    expect((proposalTurn!.parts.at(-1) as { type?: string }).type).toBe(ASSISTANT_APPROVAL_DATA_PART);
    expect(JSON.stringify(proposalTurn)).not.toContain("Approved — done.");
    // Boundary: zero-text, only the data-continuation part, names the batch.
    expect(boundary!.parts).toEqual([
      { type: "data-continuation", data: { batchId: "b1", ts: expect.any(String) } },
    ]);
    // Continuation: fresh id, only the appended parts, no carrier.
    expect(continuation!.id).not.toBe("a1");
    expect(continuation!.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Approved — done.", state: "done" },
    ]);
    expect(messageCarriesBatch(continuation, "b1")).toBe(false);
  });

  it("is idempotent — a batch already carrying a boundary is returned untouched", () => {
    const split = withContinuationBoundary([combinedTurn()]);
    const again = withContinuationBoundary(split);

    expect(again).toBe(split);
    expect(again.filter((m) => JSON.stringify(m).includes('"data-continuation"'))).toHaveLength(1);
  });

  it("leaves a carrier-only message untouched — an unrelated persist neither splits nor consumes", () => {
    const [carrierOnly] = withApprovalCarriers([assistantTurn(proposal())]);
    const input = [carrierOnly!];

    expect(withContinuationBoundary(input)).toBe(input);
  });

  it("leaves a no-carrier message untouched — no stray empty continuation", () => {
    const legacy = {
      id: "legacy",
      role: "assistant",
      parts: [
        { type: "text", text: "I can do that." },
        { type: "tool-create_task", toolCallId: "call_1", state: "output-available", input: {}, output: proposal() },
        { type: "step-start" },
        { type: "text", text: "continued", state: "done" },
      ],
    } as unknown as UIMessage;

    const input = [legacy];
    const split = withContinuationBoundary(input);
    expect(split).toBe(input);
    expect(split).toHaveLength(1);
    // persistMessages derives carriers AFTER the split: still one message, no boundary.
    const prepared = withApprovalCarriers(split);
    expect(prepared).toHaveLength(1);
    expect(JSON.stringify(prepared)).not.toContain('"data-continuation"');
    expect((prepared[0]!.parts.at(-1) as { type?: string }).type).toBe(ASSISTANT_APPROVAL_DATA_PART);
  });

  it("keeps every pre-existing carrier in the proposal and splits after the last (multi-carrier)", () => {
    const [proposalTurn] = withApprovalCarriers([assistantTurn(proposal())]);
    const multi = {
      ...proposalTurn!,
      parts: [
        ...proposalTurn!.parts,
        { type: ASSISTANT_APPROVAL_DATA_PART, data: { batchId: "b2", approvals: [] } },
        { type: "step-start" },
        { type: "text", text: "follow-up", state: "done" },
      ],
    } as unknown as UIMessage;

    const split = withContinuationBoundary([multi]);
    expect(split).toHaveLength(3);
    const [proposalBubble, boundary, continuation] = split;
    expect(approvalCarriersOf(proposalBubble).map((c) => c.batchId)).toEqual(["b1", "b2"]);
    expect(JSON.stringify(proposalBubble)).not.toContain("follow-up");
    expect(boundary!.parts).toEqual([
      { type: "data-continuation", data: { batchId: "b2", ts: expect.any(String) } },
    ]);
    expect(continuation!.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "follow-up", state: "done" },
    ]);
  });

  it("keeps a re-proposed write in the continuation bubble (carrier derived after the split)", () => {
    const [proposalTurn] = withApprovalCarriers([assistantTurn(proposal())]);
    const combined = {
      ...proposalTurn!,
      parts: [
        ...proposalTurn!.parts,
        { type: "step-start" },
        {
          type: "tool-create_task",
          toolCallId: "call_2",
          state: "output-available",
          input: {},
          output: proposal({ approvalId: "w2", batchId: "b2" }),
        },
      ],
    } as unknown as UIMessage;

    const withCarriers = withApprovalCarriers(withContinuationBoundary([combined]));
    expect(withCarriers).toHaveLength(3);
    const [proposalBubble, , continuation] = withCarriers;
    expect(approvalCarriersOf(proposalBubble).map((c) => c.batchId)).toEqual(["b1"]);
    expect(JSON.stringify(proposalBubble)).not.toContain("call_2");
    expect(approvalCarriersOf(continuation).map((c) => c.batchId)).toEqual(["b2"]);
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
