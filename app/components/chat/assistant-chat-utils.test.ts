import { describe, expect, it } from "vitest";
import { chatStreamBody } from "./assistant-chat-logic";
import { chipFromPendingApproval, parseApprovalExecutionError, renderTranscript } from "./assistant-chat-utils";

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

describe("chatStreamBody effort envelope (composer EFFORT control)", () => {
  // docs/API.md `POST /api/assistant/chat/stream` body: the per-message pick
  // rides `reasoningEffort`; the default ("") sends nothing so the project
  // setting decides. Both were unset on the owner's 506s turn.
  it("carries the picked effort, and omits it for the project default", () => {
    expect(chatStreamBody({ projectId: "p1", chatId: "c1", message: "hi", effort: "low" }).reasoningEffort).toBe("low");
    expect(chatStreamBody({ projectId: "p1", chatId: "c1", message: "hi", effort: "" }).reasoningEffort).toBeUndefined();
  });
});

describe("renderTranscript persisted tool parts", () => {
  // The read path maps a persisted `toolLog` to `tool-<name>` parts; the turn
  // must then render its process fold (tool rows) instead of pure thinking, and
  // a tool-only turn must survive the empty-turn guard.
  it("rebuilds the activity fold from the persisted tool parts", () => {
    const parts = [
      { type: "text", text: "done" },
      { type: "tool-search_wiki", toolCallId: "legacy-0-tool-0", state: "input-available", input: { detail: 'Searching wiki for "x"' } },
    ];
    const turns = renderTranscript([{ id: "legacy-0", role: "assistant", parts }]);
    expect(turns[0]?.activity?.tools.map((t) => t.name)).toEqual(["search_wiki"]);
    expect(turns[0]?.activity?.items.map((i) => i.kind)).toContain("tool");

    const toolOnly = renderTranscript([
      { id: "legacy-1", role: "assistant", parts: [{ type: "tool-read_wiki_page", toolCallId: "legacy-1-tool-0", state: "input-available", input: {} }] },
    ]);
    expect(toolOnly).toHaveLength(1);
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
