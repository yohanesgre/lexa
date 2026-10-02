// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatHeader } from "./AssistantChatShell";

function renderHeader(over: Partial<Parameters<typeof ChatHeader>[0]> = {}) {
  const handlers = { onRename: vi.fn(), onPinToggle: vi.fn(), onDelete: vi.fn() };
  render(
    <ChatHeader landing={false} loading={false} title="Auth rework" projectName="Project 1"
      updatedAt="2026-09-30T05:00:00Z" pinned={false} actionsDisabled={false} {...handlers} {...over} />
  );
  return handlers;
}

describe("ChatHeader", () => {
  it("shows the thread title and project · updated", () => {
    renderHeader();
    expect(screen.getByText("Auth rework")).toBeTruthy();
    expect(screen.getByText(/Project 1 · updated/)).toBeTruthy();
  });

  it("renames through the title: Enter saves, Esc cancels, empty is a no-op", () => {
    const { onRename } = renderHeader();
    fireEvent.click(screen.getByLabelText("Rename thread"));
    const input = screen.getByLabelText("Thread title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("New name");

    fireEvent.click(screen.getByLabelText("Rename thread"));
    const again = screen.getByLabelText("Thread title");
    fireEvent.change(again, { target: { value: "x" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Rename thread"));
    const third = screen.getByLabelText("Thread title");
    fireEvent.change(third, { target: { value: "   " } });
    fireEvent.keyDown(third, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Thread title")).toBeTruthy();
  });

  it("toggles pin with aria-pressed and confirms delete through the dialog", () => {
    const { onPinToggle, onDelete } = renderHeader({ pinned: true });
    expect(screen.getByLabelText("Pin thread").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Pin thread"));
    expect(onPinToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Delete thread"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("disables the actions while a stream runs", () => {
    renderHeader({ actionsDisabled: true });
    expect(screen.getByLabelText("Rename thread")).toBeDisabled();
    expect(screen.getByLabelText("Pin thread")).toBeDisabled();
    expect(screen.getByLabelText("Delete thread")).toBeDisabled();
  });

  it("renders the landing variant without actions", () => {
    renderHeader({ landing: true, title: null, updatedAt: null });
    expect(screen.getByText("Assistant Chat")).toBeTruthy();
    expect(screen.queryByLabelText("Delete thread")).toBeNull();
  });
});
