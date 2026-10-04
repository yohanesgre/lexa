// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { DiffResult } from "../../../shared/diff";
import { ReviewBanner } from "./ReviewBanner";

const diff: DiffResult = { oldText: "old", newText: "new", additions: 1, deletions: 1, hunks: [] };

describe("ReviewBanner", () => {
  it("rejects on Escape from page chrome", () => {
    const onReject = vi.fn();
    render(<ReviewBanner skillName="Review" agentName="Assistant" diff={diff} onAccept={vi.fn()} onReject={onReject} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("does not reject while typing in an editable field", () => {
    const onReject = vi.fn();
    render(
      <>
        <input aria-label="review note" />
        <ReviewBanner skillName="Review" agentName="Assistant" diff={diff} onAccept={vi.fn()} onReject={onReject} />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("review note"), { key: "Escape" });
    expect(onReject).not.toHaveBeenCalled();
  });
});
