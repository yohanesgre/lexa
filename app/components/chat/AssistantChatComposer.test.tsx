// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantChatComposer } from "./AssistantChatComposer";

// Mobile fold: the deck can collapse to one bar so the transcript keeps the
// height the rail, textarea, and footer would take — without losing the draft
// or the Stop control of a running turn.
function renderComposer(props: { streaming?: boolean; onAbort?: () => void } = {}) {
  return render(
    <AssistantChatComposer
      slug="project-1"
      streaming={props.streaming ?? false}
      busy409={false}
      suspendedLock={false}
      suspendCount={0}
      attachDisabled={false}
      collapsible
      onSend={() => true}
      onAbort={props.onAbort ?? (() => {})}
    />
  );
}

describe("AssistantChatComposer fold", () => {
  it("hides the message field when folded and restores the draft when expanded", () => {
    renderComposer();
    const field = screen.getByRole("combobox", { name: "Message Assistant" });
    fireEvent.change(field, { target: { value: "keep me" } });

    fireEvent.click(screen.getByRole("button", { name: "Collapse composer" }));
    expect(screen.queryByRole("combobox", { name: "Message Assistant" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Message Assistant" }));
    expect(screen.getByRole("combobox", { name: "Message Assistant" })).toHaveValue("keep me");
  });

  it("keeps Stop reachable while folded during a stream", () => {
    const onAbort = vi.fn();
    renderComposer({ streaming: true, onAbort });

    fireEvent.click(screen.getByRole("button", { name: "Collapse composer" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
