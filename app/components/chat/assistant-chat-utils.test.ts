import { describe, expect, it } from "vitest";
import { chipFromPendingApproval, parseApprovalExecutionError } from "./assistant-chat-utils";

// D3 contract (docs/API.md `approval_result` failed + docs/SCHEMA.md
// `execution_error`): an approved write whose execution failed must rebuild as
// the `failed` chip so the transcript shows the error, not a clean `approved`.
const DIFF = { type: "task_create", title: "T", fields: {} } as const;

describe("chipFromPendingApproval execution failure", () => {
  it("maps a persisted executionError to the failed terminal state", () => {
    const chip = chipFromPendingApproval(
      { approvalId: "a1", seq: 1, name: "create_task", diff: DIFF, status: "approved", executionError: "ASSISTANT_WRITE_FAILED: nope" },
      "b1"
    );
    expect(chip?.state).toBe("failed");
    expect(chip?.error).toEqual({ code: "ASSISTANT_WRITE_FAILED", message: "nope" });
  });

  it("stays approved when no executionError is recorded", () => {
    const chip = chipFromPendingApproval({ approvalId: "a1", seq: 1, name: "create_task", diff: DIFF, status: "approved" }, "b1");
    expect(chip?.state).toBe("approved");
    expect(chip?.error).toBeUndefined();
  });
});

describe("parseApprovalExecutionError", () => {
  it("splits CODE: message at the first colon", () => {
    expect(parseApprovalExecutionError("ASSISTANT_WRITE_FAILED: bad: thing")).toEqual({
      code: "ASSISTANT_WRITE_FAILED",
      message: "bad: thing",
    });
  });
});
