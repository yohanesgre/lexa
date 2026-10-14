import { describe, expect, it } from "vitest";
import { chatAttachmentsReady, chipFromPendingApproval, parseApprovalExecutionError, renderTranscript, turnMayHaveAppliedWrite } from "./assistant-chat-utils";
import type { ComposerAttachment } from "../../lib/assistant-image";
import { nextTurnsAfterStreamError, truncateTurns } from "./assistant-chat-logic";

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

describe("renderTranscript user attachments", () => {
  // The empty-turn guard counted images only, so a user message that was just a
  // document vanished from the transcript — and with it the file chip.
  it("keeps a document-only user turn and its attachment", () => {
    const turns = renderTranscript([
      { id: "u1", role: "user", parts: [{ type: "data-attachment", data: { storageKey: "k-1", mimeType: "text/plain", name: "notes.txt" } }] },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.attachments).toEqual([{ storageKey: "k-1", mimeType: "text/plain", name: "notes.txt" }]);
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

describe("chat attachment readiness", () => {
  const attachment = (status: ComposerAttachment["status"], storageKey?: string): ComposerAttachment => ({
    id: "attachment",
    kind: "document",
    file: {} as File,
    name: "notes.txt",
    size: 1,
    mimeType: "text/plain",
    status,
    progress: 100,
    ...(storageKey ? { storageKey } : {}),
  });

  it("requires every retained attachment to be ready and stored", () => {
    expect(chatAttachmentsReady([])).toBe(true);
    expect(chatAttachmentsReady([attachment("ready", "key-1")])).toBe(true);
    expect(chatAttachmentsReady([attachment("ready")])).toBe(false);
    expect(chatAttachmentsReady([attachment("failed")])).toBe(false);
    expect(chatAttachmentsReady([attachment("extraction-failed", "key-1")])).toBe(false);
    expect(chatAttachmentsReady([attachment("ready", "key-1"), attachment("uploading")])).toBe(false);
  });
});

describe("turn write retry eligibility", () => {
  const turn = {
    role: "assistant" as const,
    text: "Reply",
    imageCount: 0,
    rawIndex: 1,
  };

  it("keeps retries for read-only tool activity", () => {
    expect(turnMayHaveAppliedWrite({
      ...turn,
      activity: {
        items: [],
        tools: [{ key: "search-1", name: "search_wiki", label: "Searching wiki", phase: "result" }],
        reasoningMs: null,
      },
    })).toBe(false);
  });

  it("suppresses retries after write execution or an indeterminate generation failure", () => {
    expect(turnMayHaveAppliedWrite({
      ...turn,
      activity: {
        items: [],
        tools: [{ key: "task-1", name: "create_task", label: "Create task", phase: "result" }],
        reasoningMs: null,
      },
    })).toBe(true);
    expect(turnMayHaveAppliedWrite({
      ...turn,
      batch: {
        batchId: "batch-1",
        chips: [{ approvalId: "approval-1", batchId: "batch-1", seq: 0, name: "create_task", diff: DIFF, state: "approved" }],
      },
    })).toBe(true);
    expect(turnMayHaveAppliedWrite({
      ...turn,
      text: "",
      error: { code: "ASSISTANT_GENERATION_FAILED", message: "failed" },
    })).toBe(true);
    expect(turnMayHaveAppliedWrite({
      ...turn,
      error: { code: "ASSISTANT_TASK_ACTIVE", message: "replay refused" },
    })).toBe(true);
  });
  it("keeps retries after a write was explicitly denied", () => {
    expect(turnMayHaveAppliedWrite({
      ...turn,
      batch: {
        batchId: "batch-1",
        chips: [{ approvalId: "approval-1", batchId: "batch-1", seq: 0, name: "create_task", diff: DIFF, state: "rejected", executionStatus: "denied" }],
      },
    })).toBe(false);
  });

});
describe("failed turn convergence", () => {
  it("replaces the selected raw-index tail after a render rebuilds the turn objects", () => {
    const loaded = renderTranscript([
      { role: "user", content: "first" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "retry this" },
      { role: "assistant", content: "stopped partial", stopped: true },
      { role: "user", content: "later" },
      { role: "assistant", content: "later reply" },
    ]);
    const selected = { ...loaded[2]! };
    const next = truncateTurns(loaded, selected, "edited request");
    expect(next.map((turn) => ({ role: turn.role, rawIndex: turn.rawIndex }))).toEqual([
      { role: "user", rawIndex: 0 },
      { role: "assistant", rawIndex: 1 },
      { role: "user", rawIndex: 2 },
    ]);
    expect(next.at(-1)?.text).toBe("edited request");
    expect(loaded).toHaveLength(6);
  });
  it("updates partial text on a repeated terminal error without adding another bubble", () => {
    const previous = [
      { role: "user" as const, text: "make a plan", imageCount: 0, rawIndex: 0 },
      {
        role: "assistant" as const,
        text: "partial",
        imageCount: 0,
        rawIndex: -1,
        error: { code: "ASSISTANT_GENERATION_FAILED", message: "failed" },
      },
    ];
    const next = nextTurnsAfterStreamError(previous, {
      code: "ASSISTANT_GENERATION_FAILED",
      text: "partial answer",
      error: { code: "ASSISTANT_GENERATION_FAILED", message: "failed" },
      activity: undefined,
    });
    expect(next).toHaveLength(2);
    expect(next[1]?.text).toBe("partial answer");
    expect(next[1]?.error?.code).toBe("ASSISTANT_GENERATION_FAILED");
  });
});
