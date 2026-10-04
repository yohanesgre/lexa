// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GithubIssue } from "../../../shared/types";
import { GitHubCreateConfirmDialog } from "./GitHubCreateConfirmDialog";
import { GitHubUnlinkDialog } from "./GitHubUnlinkDialog";

const ISSUE: GithubIssue = {
  issueId: "ghi1",
  issueNumber: 107,
  repo: "emberfall-godot",
  title: "Crash on large board load",
  syncedState: "open",
  url: "https://github.com/emberfall-godot/issues/107",
  outOfSync: false,
  pushFailed: false,
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub dialogs", () => {
  it("closes the unlink dialog on Escape and focuses Cancel", () => {
    const onCancel = vi.fn();
    render(<GitHubUnlinkDialog issue={ISSUE} onConfirm={vi.fn()} onCancel={onCancel} />);

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes the create-confirm dialog on Escape and focuses Cancel", () => {
    const onCancel = vi.fn();
    render(
      <GitHubCreateConfirmDialog
        columnGithubState={null}
        selectedRepo="emberfall-godot"
        creating={false}
        onCreate={vi.fn()}
        onCancel={onCancel}
      />
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
