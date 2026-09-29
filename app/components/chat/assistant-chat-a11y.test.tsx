// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import { AssistantBubble } from "./AssistantBubble";
import { ChatJumpButton, StreamingBubble } from "./AssistantChatTurns";
import { ChatHeader } from "./AssistantChatShell";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import type { ChatTurn } from "./assistant-chat-utils";

type Stream = ReturnType<typeof useAssistantStream>;

const noopRenderText = (text: string) => text;

function chip(overrides: Partial<ApprovalChip> = {}): ApprovalChip {
  return {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "wiki_create",
    diff: { type: "wiki_create", slug: "setup", title: "Setup", bodyText: "body" },
    state: "pending",
    ...overrides,
  };
}

const THREAD_TITLE = "Sprint notes";

function renderHeader(onDelete: () => void | Promise<unknown> = () => {}) {
  render(
    <ChatHeader
      landing={false}
      loading={false}
      title={THREAD_TITLE}
      projectName="Project 1"
      updatedAt="2026-01-01T00:00:00Z"
      pinned={false}
      actionsDisabled={false}
      onRename={() => {}}
      onPinToggle={() => {}}
      onDelete={onDelete}
    />
  );
}

describe("assistant chat a11y", () => {
  it("names each approval button after its chip target", () => {
    render(
      <AssistantApprovalBatch
        chips={[chip({ seq: 0, diff: { type: "wiki_create", slug: "setup", title: "Setup", bodyText: "b" } }), chip({ approvalId: "a2", seq: 1, name: "task_update", diff: { type: "task_update", taskRef: "NIM-231", taskTitle: "T", changes: [] } })]}
        locked={false}
        onDecide={() => {}}
        onApproveAll={() => {}}
        onRejectAll={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Approve wiki_create setup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject wiki_create setup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve task_update NIM-231" })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Approve" })).toHaveLength(0);
  });

  it("keeps the jump button out of the tab order while hidden", () => {
    const { container: hidden } = render(<ChatJumpButton atBottom onClick={() => {}} />);
    const hiddenBtn = hidden.querySelector("button")!;
    expect(hiddenBtn).toHaveAttribute("tabindex", "-1");
    expect(hiddenBtn).toHaveAttribute("aria-hidden", "true");

    const { container: shown } = render(<ChatJumpButton atBottom={false} onClick={() => {}} />);
    const shownBtn = shown.querySelector("button")!;
    expect(shownBtn).toHaveAttribute("tabindex", "0");
    expect(shownBtn).toHaveAttribute("aria-hidden", "false");
  });

  it("renders a single wireframe meta line while streaming", () => {
    const stream = { items: [], tools: [], reasoningActive: false, reasoningMs: null, pending: [] } as unknown as Stream;
    const { container } = render(<StreamingBubble stream={stream} skillName="Requirements" renderText={noopRenderText} />);
    const metas = container.querySelectorAll(".bubble-meta");
    expect(metas).toHaveLength(1);
    expect(metas[0]!.textContent).toBe("Assistant · Assistant Agent persona · Requirements");
  });

  it("renders the token usage line under the done reply", () => {
    const turn: ChatTurn = { role: "assistant", text: "Done.", imageCount: 0, rawIndex: 0 };
    render(
      <AssistantBubble
        turn={turn}
        streaming={false}
        renderText={noopRenderText}
        usage={{ in: 892, out: 1103 }}
        batchBusy={false}
        onDecide={() => {}}
        onApproveAll={() => {}}
        onRejectAll={() => {}}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText(/↑ 892 · ↓ 1,103 tokens/)).toBeTruthy();
  });

  it("traps focus in the delete dialog, closes on Escape, and restores the trigger", async () => {
    renderHeader();
    const trigger = screen.getByLabelText("Delete thread");
    fireEvent.click(trigger);

    expect(screen.getByText(/The view lands on a fresh empty chat\./)).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    const dialog = screen.getByRole("dialog");
    const deleteChat = screen.getByRole("button", { name: "Delete chat" });
    deleteChat.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Cancel delete" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not close the delete dialog on Escape while deleting", async () => {
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderHeader(onDelete);
    fireEvent.click(screen.getByLabelText("Delete thread"));
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    resolveDelete?.();
  });
});
