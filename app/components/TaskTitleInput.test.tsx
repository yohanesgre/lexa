// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskTitleInput } from "./TaskTitleInput";

const writeText = vi.fn();

function renderTitle(overrides: Partial<Parameters<typeof TaskTitleInput>[0]> = {}) {
  return render(
    <TaskTitleInput
      isArchived={false}
      isCreate={false}
      createTitle=""
      setCreateTitle={() => {}}
      onCreate={() => {}}
      onClose={() => {}}
      editingTitle={false}
      draft=""
      setDraft={() => {}}
      onSaveTitle={() => {}}
      setEditingTitle={() => {}}
      taskTitle="Crash on large board load"
      taskKey="EG-18"
      slug="demo"
      {...overrides}
    />
  );
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("TaskTitleInput", () => {
  it("copies the full task URL with the ticket key", async () => {
    renderTitle();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/demo/tasks/EG-18`);
    });
  });

  it("renders the ticket key and title with an 8px gap", () => {
    renderTitle();
    expect(screen.getByText("EG-18")).toBeInTheDocument();
    expect(screen.getByText("Crash on large board load")).toBeInTheDocument();
    expect(screen.getByTitle("Click to edit")).toHaveStyle({ display: "flex", gap: "8px" });
  });
});
