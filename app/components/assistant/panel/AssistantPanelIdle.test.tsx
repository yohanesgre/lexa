// @vitest-environment jsdom
// AssistantPanelIdle (herald-popover.html States 1–2): auto skill selection —
// no skill picker in the panel, and Generate is gated only on the assistant
// being configured + the create not already pending.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssistantPanelIdle } from "./AssistantPanelIdle";

const settings = { kind: "openai_compatible", model: "gpt" } as never;

function renderIdle(overrides: Partial<React.ComponentProps<typeof AssistantPanelIdle>> = {}) {
  const onGenerate = vi.fn();
  render(
    <AssistantPanelIdle
      prompt=""
      onPromptChange={vi.fn()}
      docImages={[]}
      selectionText=""
      settings={settings}
      createPending={false}
      onGenerate={onGenerate}
      {...overrides}
    />
  );
  return { onGenerate };
}

describe("AssistantPanelIdle", () => {
  it("shows no skill picker and enables Generate with only the assistant configured", () => {
    const { onGenerate } = renderIdle();
    expect(screen.queryByText("Skill")).not.toBeInTheDocument();
    const generate = screen.getByRole("button", { name: /Generate/ });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps Generate disabled when no provider is configured", () => {
    renderIdle({ settings: null });
    expect(screen.getByRole("button", { name: /Generate/ })).toBeDisabled();
  });

  it("triggers Generate on Cmd/Ctrl+Enter when configured", () => {
    const { onGenerate } = renderIdle();
    fireEvent.keyDown(screen.getByLabelText("Additional prompt"), { key: "Enter", metaKey: true });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("triggers Generate on Ctrl+Enter too", () => {
    const { onGenerate } = renderIdle();
    fireEvent.keyDown(screen.getByLabelText("Additional prompt"), { key: "Enter", ctrlKey: true });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("keeps Generate disabled and Cmd/Ctrl+Enter a no-op while a create is pending", () => {
    const { onGenerate } = renderIdle({ createPending: true });
    expect(screen.getByRole("button", { name: /Starting/ })).toBeDisabled();
    const prompt = screen.getByLabelText("Additional prompt");
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true });
    fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
