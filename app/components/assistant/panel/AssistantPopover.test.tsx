// @vitest-environment jsdom
// AssistantPopover — the assistant-only editor Generate popover shell
// (herald-popover.html). Renders the panel in a body portal when open; closed
// renders nothing. Owns dialog semantics, focus management, and dismiss.
import "@testing-library/jest-dom/vitest";
import { useEffect, useRef, useState, type RefObject } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

vi.mock("./AssistantPanel", () => ({
  // Mirrors AssistantPanelIdle: a passive effect autofocuses the prompt, so
  // the opener capture must not treat that in-portal focus as the opener.
  AssistantPanel: (props: { slug: string; documentId: string }) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      ref.current?.focus();
    }, []);
    return (
      <div data-testid="assistant-panel" data-slug={props.slug} data-document={props.documentId}>
        <textarea ref={ref} aria-label="Prompt" />
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    );
  },
}));

import { AssistantPopover } from "./AssistantPopover";

const editor = {} as Editor;

function renderPopover(overrides: Partial<React.ComponentProps<typeof AssistantPopover>> = {}) {
  return render(
    <AssistantPopover
      editor={editor}
      slug="demo"
      documentType="task"
      documentId="t1"
      open
      onClose={vi.fn()}
      onReview={vi.fn()}
      reviewActive={false}
      anchorRect={null}
      {...overrides}
    />
  );
}

function makeTrigger(): { trigger: HTMLButtonElement; triggerRef: RefObject<HTMLElement | null> } {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("data-assistant-trigger", "");
  document.body.appendChild(trigger);
  return { trigger, triggerRef: { current: trigger } };
}

afterEach(() => cleanup());

describe("AssistantPopover", () => {
  it("renders the assistant panel in a portal marked data-assistant-popover", () => {
    renderPopover();
    const marker = document.querySelector("[data-assistant-popover]");
    expect(marker).not.toBeNull();
    expect(screen.getByTestId("assistant-panel")).toHaveAttribute("data-slug", "demo");
    expect(screen.getByTestId("assistant-panel")).toHaveAttribute("data-document", "t1");
  });

  it("renders nothing when closed", () => {
    renderPopover({ open: false });
    expect(document.querySelector("[data-assistant-popover]")).toBeNull();
    expect(screen.queryByTestId("assistant-panel")).not.toBeInTheDocument();
  });

  it("exposes dialog semantics", () => {
    renderPopover();
    expect(screen.getByRole("dialog", { name: "Assistant" })).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderPopover({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside mousedown", () => {
    const onClose = vi.fn();
    renderPopover({ onClose });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a mousedown inside the trigger", () => {
    const onClose = vi.fn();
    const { trigger } = makeTrigger();
    renderPopover({ onClose });
    fireEvent.mouseDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
    trigger.remove();
  });

  it("wraps Tab inside the dialog", () => {
    renderPopover();
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    const focusables = [
      screen.getByLabelText("Prompt"),
      screen.getByRole("button", { name: "first" }),
      screen.getByRole("button", { name: "last" }),
    ];
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("restores focus to the trigger on Escape-close when the child autofocused", () => {
    const onClose = vi.fn();
    const { trigger, triggerRef } = makeTrigger();
    const { rerender } = renderPopover({ onClose, triggerRef });
    // The child autofocused the prompt (in-portal), not the trigger.
    expect(document.activeElement).toBe(screen.getByLabelText("Prompt"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <AssistantPopover
        editor={editor}
        slug="demo"
        documentType="task"
        documentId="t1"
        open={false}
        onClose={vi.fn()}
        onReview={vi.fn()}
        reviewActive={false}
        anchorRect={null}
        triggerRef={triggerRef}
      />
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("restores focus to the trigger on unmount", () => {
    const { trigger, triggerRef } = makeTrigger();
    const { unmount } = renderPopover({ triggerRef });
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("does not yank focus back on a light dismiss", () => {
    const onClose = vi.fn();
    const { trigger, triggerRef } = makeTrigger();
    const { rerender } = renderPopover({ onClose, triggerRef });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <AssistantPopover
        editor={editor}
        slug="demo"
        documentType="task"
        documentId="t1"
        open={false}
        onClose={vi.fn()}
        onReview={vi.fn()}
        reviewActive={false}
        anchorRect={null}
        triggerRef={triggerRef}
      />
    );
    expect(document.activeElement).not.toBe(trigger);
    trigger.remove();
  });
});

// The trigger toggles the popover with one click each way: the mousedown that
// precedes the click must not dismiss it first (TextEditor wiring contract).
function TriggerHost() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" data-assistant-trigger onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <AssistantPopover
        editor={editor}
        slug="demo"
        documentType="task"
        documentId="t1"
        open={open}
        onClose={() => setOpen(false)}
        onReview={vi.fn()}
        reviewActive={false}
        anchorRect={null}
        triggerRef={triggerRef}
      />
    </>
  );
}

describe("AssistantPopover trigger toggle", () => {
  it("opens on one click and closes on the next", () => {
    render(<TriggerHost />);
    const trigger = screen.getByRole("button", { name: "trigger" });
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.getByTestId("assistant-panel")).toBeInTheDocument();
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("assistant-panel")).not.toBeInTheDocument();
  });
});
