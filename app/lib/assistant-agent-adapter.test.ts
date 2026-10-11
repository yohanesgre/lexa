// ADR-0003 P4b (WS1) + LX-120: approval-suspension projection.
//
// The load-bearing protection here is the duplicate-execution guard: two carriers
// for one approval (the merged shape the DO persists) must settle to ONE terminal
// chip in either arrival order. If a pending carrier overwrites a terminal chip,
// the batch re-arms and the UI POSTs `/resume` for an already-executed batch.
// Also retained: the run-status→card-state mapping and the LX-124 resend boundary
// (merged from assistant-run-adapter / resendIndex).
import { describe, expect, it } from "vitest";
import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from "ai";
import type { AssistantRunRow, AssistantWriteDiff } from "../../shared/assistant";
import { suspensionFromMessages } from "./assistant-agent-adapter";
import { liveStatusToCardState, runCardFromLive, runStatusToCardState } from "./assistant-run-adapter";
import { rawUserIndexByText, resolveRawUserIndex } from "./resendIndex";

type Part = UIMessagePart<UIDataTypes, UITools>;

const DIFF = { type: "task_create", title: "New task", fields: {} } as unknown as AssistantWriteDiff;

function assistant(parts: Part[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as unknown as UIMessage;
}

function user(text: string): UIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] as Part[] } as unknown as UIMessage;
}

function dataPart(name: string, data: unknown): Part {
  return { type: `data-${name}`, data } as unknown as Part;
}

function toolResult(name: string, toolCallId: string, input: unknown, output: unknown): Part {
  return { type: `tool-${name}`, toolCallId, state: "output-available", input, output } as unknown as Part;
}

function runRow(overrides: Partial<AssistantRunRow> = {}): AssistantRunRow {
  return {
    id: "run-1",
    projectId: "p1",
    threadKey: "chat:c1",
    parentRunId: null,
    kind: "chat_run",
    status: "running",
    goal: "Cross-check the rollback section",
    result: null,
    error: null,
    budgetMs: 600_000,
    stepsUsed: 9,
    createdBy: "u1",
    createdAt: "2026-01-01 10:00:00",
    startedAt: "2026-01-01 10:00:01",
    finishedAt: null,
    ...overrides,
  };
}

describe("segmentFromMessages — merged suspension projection (LX-120)", () => {
  it("does not re-arm an all-terminal batch and lets the later terminal carrier win", () => {
    const allTerminal = suspensionFromMessages([
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
    ]);
    expect(allTerminal.suspendedBatchId).toBeNull();
    expect(allTerminal.pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "approved", diff: DIFF },
    ]);

    // Terminal-vs-terminal: the later carrier is the newer decision.
    const twoTerminal = suspensionFromMessages([
      user("go"),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
        }),
      ]),
      assistant([
        dataPart("assistant-approval", {
          batchId: "b1",
          approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "rejected" }],
        }),
      ]),
    ]);
    expect(twoTerminal.suspendedBatchId).toBeNull();
    expect(twoTerminal.pending).toEqual([
      { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "rejected", diff: DIFF },
    ]);
  });

  // Two carriers for one approval (the merged shape the DO persists): a pending
  // carrier must never overwrite an already-terminal chip, in EITHER arrival
  // order or carrier shape, or the batch re-arms and the UI POSTs `/resume` for
  // an executed batch.
  it("keeps the terminal chip when a pending carrier arrives, in either arrival order and carrier shape", () => {
    const terminalData = dataPart("assistant-approval", {
      batchId: "b1",
      approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" }],
    });
    const pendingData = dataPart("assistant-approval", {
      batchId: "b1",
      approvals: [{ approvalId: "a1", seq: 0, name: "create_task", diff: DIFF }],
    });
    const terminalTool = toolResult("create_task", "c2", {}, {
      approvalId: "a1",
      batchId: "b1",
      seq: 0,
      name: "create_task",
      detail: "Create task",
      diff: DIFF,
      status: "approved",
    });
    const pendingTool = toolResult("create_task", "c1", {}, {
      approvalId: "a1",
      batchId: "b1",
      seq: 0,
      name: "create_task",
      detail: "Create task",
      diff: DIFF,
    });
    const terminalDataChip = { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", state: "approved", diff: DIFF };
    const terminalToolChip = { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", detail: "Create task", state: "approved", diff: DIFF };

    // data-part carriers: terminal → pending and pending → terminal
    let result = suspensionFromMessages([user("go"), assistant([terminalData]), assistant([pendingData])]);
    expect(result.suspendedBatchId).toBeNull();
    expect(result.pending).toEqual([terminalDataChip]);
    result = suspensionFromMessages([user("go"), assistant([pendingData]), assistant([terminalData])]);
    expect(result.suspendedBatchId).toBeNull();
    expect(result.pending).toEqual([terminalDataChip]);

    // The decision can also ride the live proposal output; the adapter must read
    // `output.status` or a terminal carrier projects as pending.
    result = suspensionFromMessages([user("go"), assistant([pendingTool]), assistant([terminalTool])]);
    expect(result.suspendedBatchId).toBeNull();
    expect(result.pending).toEqual([terminalToolChip]);
    result = suspensionFromMessages([user("go"), assistant([terminalTool]), assistant([pendingData])]);
    expect(result.suspendedBatchId).toBeNull();
    expect(result.pending).toEqual([terminalToolChip]);
  });
});

// Merged from assistant-run-adapter.test.ts — the status mapping and the
// interrupt classification carried on the run card.
describe("run status → card state", () => {
  it("maps the registry and live SDK statuses 1:1 (aborted → stopped)", () => {
    expect(runStatusToCardState("queued")).toBe("dispatching");
    expect(runStatusToCardState("running")).toBe("running");
    expect(runStatusToCardState("completed")).toBe("done");
    expect(runStatusToCardState("failed")).toBe("failed");
    expect(runStatusToCardState("cancelled")).toBe("stopped");

    expect(liveStatusToCardState("running")).toBe("running");
    expect(liveStatusToCardState("completed")).toBe("done");
    expect(liveStatusToCardState("error")).toBe("failed");
    expect(liveStatusToCardState("interrupted")).toBe("failed");
    expect(liveStatusToCardState("aborted")).toBe("stopped");
  });

  it("keeps a soft interrupt Running and lands a hard interrupt as Failed with the live error", () => {
    const soft = runCardFromLive(runRow(), { status: "interrupted", childStillRunning: true });
    expect(soft.state).toBe("running");

    const hard = runCardFromLive(runRow(), { status: "interrupted", childStillRunning: false, error: "ASSISTANT_RUN_BUDGET_EXCEEDED" });
    expect(hard.state).toBe("failed");
    expect(hard.error).toBe("ASSISTANT_RUN_BUDGET_EXCEEDED");
  });
});

// Merged from resendIndex.test.ts — LX-124: the split persists a zero-text
// `data-continuation` boundary marker and a text-only continuation as assistant
// messages. Resend targeting keys on role+text and must never latch onto either.
describe("resendIndex — LX-124 continuation boundary", () => {
  const rawUser = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
  const boundary = (batchId: string) => ({
    role: "assistant",
    parts: [{ type: "data-continuation", data: { batchId, ts: "2026-01-01T00:00:00Z" } }],
  });
  const continuation = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });

  const splitTranscript = [
    rawUser("go"),
    { role: "assistant", parts: [{ type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } }] },
    boundary("b1"),
    continuation("Done — nothing ran."),
  ];

  it("never maps a resend target onto the boundary or continuation", () => {
    expect(rawUserIndexByText(splitTranscript, "")).toBeNull();
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: 2, text: "" }, 0)).toBeNull();
    expect(resolveRawUserIndex(splitTranscript, { rawIndex: 3, text: "Done — nothing ran." }, 0)).toBeNull();
  });
});
