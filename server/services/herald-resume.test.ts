import { describe, expect, it } from "vitest";
import { findPendingBatch, applyResumeResults } from "./herald.service";

describe("findPendingBatch", () => {
  it("returns null for a transcript with no pendingBatch marker", () => {
    expect(findPendingBatch([])).toBeNull();
    expect(findPendingBatch([{ role: "user", content: "hi" }])).toBeNull();
    expect(findPendingBatch([{ role: "assistant", content: "hello" }])).toBeNull();
  });

  it("finds the newest marker first (newest-first scan)", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "a", pendingBatch: "batch-old" },
      { role: "user", content: "more" },
      { role: "assistant", content: "b", pendingBatch: "batch-new" },
    ];
    expect(findPendingBatch(messages)).toBe("batch-new");
  });

  it("ignores non-string or null entries", () => {
    expect(findPendingBatch([null, { pendingBatch: 42 }, { pendingBatch: "real" }])).toBe("real");
  });

  it("reads the PendingBatchMarker object shape", () => {
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        pendingBatch: { batchId: "batch-obj", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] },
      },
    ];
    expect(findPendingBatch(messages)).toBe("batch-obj");
  });

  it("object shape wins over legacy string when newest (newest-first scan)", () => {
    const messages = [
      { role: "assistant", content: "old", pendingBatch: "batch-string" },
      { role: "assistant", content: "new", pendingBatch: { batchId: "batch-object", approvals: [] } },
    ];
    expect(findPendingBatch(messages)).toBe("batch-object");
  });
});

describe("applyResumeResults", () => {
  it("clears the pendingBatch marker of resolved batches, keeping the rest of the entry", () => {
    const entry = {
      role: "assistant",
      content: "proposed writes",
      ts: "2026-08-24T00:00:00Z",
      toolCalls: [{ name: "create_task" }],
      pendingBatch: "b1",
    };
    const out = applyResumeResults([entry], ["b1"]);
    expect(out).toHaveLength(1);
    expect(out[0]!).toEqual({
      role: "assistant",
      content: "proposed writes",
      ts: "2026-08-24T00:00:00Z",
      toolCalls: [{ name: "create_task" }],
    });
  });

  it("leaves markers of unresolved batches and untouched entries alone", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "a", pendingBatch: "b1" },
      { role: "assistant", content: "b", pendingBatch: "b2" },
    ];
    const out = applyResumeResults(messages, ["b1"]);
    expect(out[0]!).toEqual(messages[0]!);
    expect(out[1]!).toEqual({ role: "assistant", content: "a" });
    expect(out[2]!).toEqual(messages[2]!);
  });

  it("does not mutate the input transcript", () => {
    const messages = [{ role: "assistant", content: "a", pendingBatch: "b1" }];
    applyResumeResults(messages, ["b1"]);
    expect(messages[0]!).toHaveProperty("pendingBatch", "b1");
  });

  it("handles null entries without throwing", () => {
    expect(applyResumeResults([null, { pendingBatch: "b1" }], ["b1"])).toEqual([null, {}]);
  });

  it("clears PendingBatchMarker object markers of resolved batches", () => {
    const entry = {
      role: "assistant",
      content: "proposed writes",
      ts: "2026-08-24T00:00:00Z",
      pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] },
    };
    const out = applyResumeResults([{ role: "user", content: "go" }, entry], ["b1"]);
    expect(out[0]!).toEqual({ role: "user", content: "go" });
    expect(out[1]!).toEqual({ role: "assistant", content: "proposed writes", ts: "2026-08-24T00:00:00Z" });
  });

  it("leaves object markers of unresolved batches alone", () => {
    const entry = { role: "assistant", content: "a", pendingBatch: { batchId: "b2", approvals: [] } };
    const out = applyResumeResults([entry], ["b1"]);
    expect(out[0]!).toEqual(entry);
  });

  it("mixed shapes resolve independently", () => {
    const messages = [
      { role: "assistant", content: "legacy", pendingBatch: "b1" },
      { role: "assistant", content: "object", pendingBatch: { batchId: "b2", approvals: [] } },
    ];
    const out = applyResumeResults(messages, ["b1", "b2"]);
    expect(out).toEqual([
      { role: "assistant", content: "legacy" },
      { role: "assistant", content: "object" },
    ]);
  });
});
