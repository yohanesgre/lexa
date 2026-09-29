// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import type { AssistantWriteDiff } from "../../../shared/assistant";

const DIFF: AssistantWriteDiff = { type: "task_create", title: "New task", fields: {} };

function chip(overrides: Partial<ApprovalChip> = {}): ApprovalChip {
  return {
    approvalId: "a1",
    batchId: "b1",
    seq: 0,
    name: "create_task",
    diff: DIFF,
    state: "pending",
    ...overrides,
  };
}

function threeChips(): ApprovalChip[] {
  return [
    chip({ approvalId: "a1", seq: 0, name: "create_task" }),
    chip({ approvalId: "a2", seq: 1, name: "move_task" }),
    chip({ approvalId: "a3", seq: 2, name: "add_comment" }),
  ];
}

function renderBatch(chips: ApprovalChip[], locked = false) {
  const onDecide = vi.fn();
  const utils = render(
    <AssistantApprovalBatch chips={chips} locked={locked} onDecide={onDecide} onApproveAll={() => {}} onRejectAll={() => {}} />
  );
  const counter = () => utils.container.querySelector(".approval-carousel-count")!.textContent;
  const carousel = () => utils.container.querySelector(".approval-carousel")!;
  return { ...utils, onDecide, counter, carousel };
}

// jsdom has no layout: paint the reviewer-observed geometry onto the real
// nodes (the track's nearest positioned ancestor is .chat-transcript, so slide
// offsetLeft carries the track's own offset as a constant shift).
function paintLayout(container: HTMLElement, trackOffsetLeft: number, slideOffsets: number[], maxScroll: number) {
  const track = container.querySelector<HTMLElement>(".approval-carousel-track")!;
  let scrollLeft = 0;
  Object.defineProperty(track, "offsetLeft", { value: trackOffsetLeft, configurable: true });
  Object.defineProperty(track, "clientWidth", { value: 0, configurable: true });
  Object.defineProperty(track, "scrollWidth", { value: maxScroll, configurable: true });
  Object.defineProperty(track, "scrollLeft", { get: () => scrollLeft, set: (v: number) => { scrollLeft = v; }, configurable: true });
  const scrollTo = vi.fn();
  Object.defineProperty(track, "scrollTo", { value: scrollTo, configurable: true });
  const slides = container.querySelectorAll<HTMLElement>(".approval-carousel-slide");
  slides.forEach((slide, i) => Object.defineProperty(slide, "offsetLeft", { value: slideOffsets[i], configurable: true }));
  const scrollToLeft = (i = -1) => {
    const calls = scrollTo.mock.calls;
    return (calls.at(i < 0 ? -1 : i)![0] as { left: number }).left;
  };
  return { track, scrollTo, scrollToLeft };
}

describe("AssistantApprovalBatch — carousel", () => {
  it("renders seq-ordered slides with one active card and an N / M counter", () => {
    const { container, counter } = renderBatch(threeChips());
    const slides = container.querySelectorAll(".approval-carousel-slide");
    expect(slides).toHaveLength(3);
    expect(slides[0]!.getAttribute("aria-label")).toBe("1 of 3");
    expect(slides[2]!.getAttribute("aria-label")).toBe("3 of 3");
    expect(counter()).toBe("1 / 3");
    expect(screen.getByRole("button", { name: "Previous change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next change" })).toBeEnabled();
  });

  it("pages one card at a time and clamps at both ends", () => {
    const { counter } = renderBatch(threeChips());
    const next = screen.getByRole("button", { name: "Next change" });
    const prev = screen.getByRole("button", { name: "Previous change" });

    fireEvent.click(next);
    expect(counter()).toBe("2 / 3");
    fireEvent.click(next);
    expect(counter()).toBe("3 / 3");
    expect(next).toBeDisabled();

    // Disabled control cannot advance past the last card.
    fireEvent.click(next);
    expect(counter()).toBe("3 / 3");

    fireEvent.click(prev);
    expect(counter()).toBe("2 / 3");
    expect(prev).toBeEnabled();
  });

  it("pages with ArrowLeft / ArrowRight and moves focus to the active card's first enabled action", () => {
    const { carousel, counter } = renderBatch(threeChips());

    // Already on the first card — ArrowLeft is a no-op, not a wrap.
    fireEvent.keyDown(carousel(), { key: "ArrowLeft" });
    expect(counter()).toBe("1 / 3");

    fireEvent.keyDown(carousel(), { key: "ArrowRight" });
    expect(counter()).toBe("2 / 3");
    expect(document.activeElement).toHaveAttribute("aria-label", "Approve move_task new");

    fireEvent.keyDown(carousel(), { key: "ArrowLeft" });
    expect(counter()).toBe("1 / 3");
  });

  it("focuses the wrapper when the active card has no enabled action button", () => {
    const decided = renderBatch([chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1, name: "move_task", state: "approved" })]);

    fireEvent.keyDown(decided.carousel(), { key: "ArrowRight" });
    expect(decided.counter()).toBe("2 / 2");
    expect(document.activeElement).toBe(decided.container.querySelectorAll(".approval-carousel-slide")[1]);
  });

  it("scrolls to the track-relative target (transcript origin) and follows the swiped card", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track, scrollToLeft } = paintLayout(container, 328, [328, 973, 1618], 1253);
    const next = screen.getByRole("button", { name: "Next change" });

    // One Next from card 1 lands on card 2 — not on the +328px-shifted offset.
    fireEvent.click(next);
    expect(scrollToLeft()).toBe(645);
    track.scrollLeft = 645;
    fireEvent.scroll(track);
    expect(counter()).toBe("2 / 3");

    // Last card: the target clamps to the scrollable end and STILL reports 3/3.
    fireEvent.click(next);
    expect(scrollToLeft()).toBe(1253);
    track.scrollLeft = 1253;
    fireEvent.scroll(track);
    expect(counter()).toBe("3 / 3");
  });

  it("follows a swipe using track-relative offsets (transcript origin)", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track } = paintLayout(container, 328, [328, 973, 1618], 1253);

    // Raw offsets reported card 2 at the clamped end (317 < 328).
    track.scrollLeft = 1253;
    fireEvent.scroll(track);
    expect(counter()).toBe("3 / 3");

    track.scrollLeft = 645;
    fireEvent.scroll(track);
    expect(counter()).toBe("2 / 3");

    track.scrollLeft = 0;
    fireEvent.scroll(track);
    expect(counter()).toBe("1 / 3");
  });

  it("does not skip to the end on a wide (1920px) layout", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track, scrollToLeft } = paintLayout(container, 328, [328, 2224, 4120], 3792);

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(scrollToLeft()).toBe(1896);
    track.scrollLeft = 1896;
    fireEvent.scroll(track);
    expect(counter()).toBe("2 / 3");

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(scrollToLeft()).toBe(3792);
    track.scrollLeft = 3792;
    fireEvent.scroll(track);
    expect(counter()).toBe("3 / 3");
  });

  it("decides per chip from the carousel without touching already-decided cards", () => {
    const chips = [chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1, name: "move_task" })];
    const { onDecide } = renderBatch(chips);

    // "Approve all" has no aria-label; the per-chip buttons do.
    const approveButtons = screen.getAllByRole("button", { name: /^Approve / }).filter((b) => b.hasAttribute("aria-label"));
    fireEvent.click(approveButtons[0]!);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]![0]!.approvalId).toBe("a1");
    expect(onDecide.mock.calls[0]![1]).toBe("approve");
  });

  it("replaces a decided card's actions with its state badge", () => {
    const chips = [chip({ approvalId: "a1", seq: 0, state: "approved" }), chip({ approvalId: "a2", seq: 1, name: "move_task" })];
    const { container } = renderBatch(chips);

    const slides = container.querySelectorAll(".approval-carousel-slide");
    expect(slides[0]!.querySelectorAll("button")).toHaveLength(0);
    expect(slides[0]!.textContent).toContain("Approved");
    expect(slides[1]!.querySelectorAll("button")).toHaveLength(2);
  });
});
