// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { ChatTranscriptArea } from "./AssistantChatShell";
import type { useAssistantStream } from "../../lib/use-assistant-stream";

type Stream = ReturnType<typeof useAssistantStream>;

// The pre-first-token shape: no items yet, so StreamingBubble renders the lone
// caret. The transcript reads only items/tools/reasoning/pending here.
const stream = {
  status: "idle",
  items: [],
  tools: [],
  reasoningActive: false,
  reasoningMs: null,
  pending: [],
} as unknown as Stream;

const renderText = (text: string) => text;

function renderArea(pendingReply: boolean) {
  return render(
    <ChatTranscriptArea
      turns={[]}
      chatId="A"
      slug="nimbus"
      streaming={false}
      pendingReply={pendingReply}
      renderText={renderText}
      streamActivity={undefined}
      batchBusy={false}
      onDecide={() => {}}
      onApproveAll={() => {}}
      onRejectAll={() => {}}
      onRetryTurn={() => {}}
      scrollRef={createRef<HTMLDivElement>()}
      onScroll={() => {}}
      editingPos={null}
      editDraft=""
      onEditDraftChange={() => {}}
      onBeginEdit={() => {}}
      onCancelEdit={() => {}}
      onCommitEdit={() => {}}
      lastUserPos={-1}
      onRegenerate={() => {}}
      stream={stream}
      atBottom
      onJump={() => {}}
    />
  );
}

describe("ChatTranscriptArea pending reply", () => {
  it("renders the assistant caret when a send is accepted but not yet streaming", () => {
    const { container } = renderArea(true);
    expect(container.querySelector(".bubble-ai")).toBeTruthy();
    expect(container.querySelector(".assistant-stream-caret")).toBeTruthy();
  });

  it("renders no assistant bubble when neither streaming nor pending", () => {
    const { container } = renderArea(false);
    expect(container.querySelector(".bubble-ai")).toBeNull();
    expect(container.querySelector(".assistant-stream-caret")).toBeNull();
  });
});
