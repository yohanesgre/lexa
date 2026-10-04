// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingBubble } from "./AssistantChatTurns";
import type { AssistantPendingChip, useAssistantStream } from "../../lib/use-assistant-stream";

type Stream = ReturnType<typeof useAssistantStream>;

const renderText = (text: string) => text;

function pendingChip(overrides: Partial<AssistantPendingChip> = {}): AssistantPendingChip {
  return {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "wiki_create",
    diff: { type: "wiki_create", slug: "setup", title: "Setup", bodyText: "body" },
    ...overrides,
  };
}

function streamWithPending(pending: AssistantPendingChip[]): Stream {
  return { items: [], tools: [], reasoningActive: false, reasoningMs: null, pending } as unknown as Stream;
}

describe("StreamingBubble pending chips", () => {
  it("passes a reconciled terminal chip state through instead of forcing pending", () => {
    render(
      <StreamingBubble
        stream={streamWithPending([
          pendingChip({ approvalId: "a1", seq: 0, state: "approved" }),
          pendingChip({
            approvalId: "a2",
            seq: 1,
            name: "task_update",
            diff: { type: "task_update", taskRef: "NIM-231", taskTitle: "T", changes: [] },
          }),
        ])}
        renderText={renderText}
      />
    );

    expect(screen.getByText(/1 approved/)).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve wiki_create/ })).toBeNull();
  });

  it("defaults an absent chip state to pending", () => {
    render(
      <StreamingBubble
        stream={streamWithPending([
          pendingChip({
            approvalId: "a2",
            seq: 0,
            name: "task_update",
            diff: { type: "task_update", taskRef: "NIM-231", taskTitle: "T", changes: [] },
          }),
        ])}
        renderText={renderText}
      />
    );

    expect(screen.getByRole("button", { name: "Approve task_update NIM-231" })).toBeTruthy();
    expect(screen.queryByText("Approved")).toBeNull();
  });
});
