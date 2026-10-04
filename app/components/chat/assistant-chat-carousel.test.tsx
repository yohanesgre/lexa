// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import { stubMatchMedia } from "../../test-utils";
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

function renderBatch(
  chips: ApprovalChip[],
  locked = false,
  decide?: (chip: ApprovalChip, verdict: "approve" | "reject") => void | Promise<void>
) {
  const onDecide = vi.fn(decide);
  const onApproveAll = vi.fn();
  const onRejectAll = vi.fn();
  const tree = (next: ApprovalChip[]) => (
    <AssistantApprovalBatch chips={next} locked={locked} onDecide={onDecide} onApproveAll={onApproveAll} onRejectAll={onRejectAll} />
  );
  const utils = render(tree(chips));
  const counter = () => utils.container.querySelector(".approval-carousel-count")!.textContent;
  const carousel = () => utils.container.querySelector(".approval-carousel")!;
  const rerenderChips = (next: ApprovalChip[]) => utils.rerender(tree(next));
  return { ...utils, onDecide, onApproveAll, onRejectAll, counter, carousel, rerenderChips };
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
  // jsdom has no layout/scroll: give every element a scrollTo, then let
  // paintLayout shadow it per-track where a test needs to capture the target.
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollTo", { value: vi.fn(), configurable: true, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  });

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

  it("pages BACKWARD from the last card onto the previous slide and stays there", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track, scrollToLeft } = paintLayout(container, 328, [328, 973, 1618], 1253);
    const next = screen.getByRole("button", { name: "Next change" });
    const prev = screen.getByRole("button", { name: "Previous change" });

    fireEvent.click(next);
    fireEvent.click(next);
    expect(counter()).toBe("3 / 3");
    expect(prev).toBeEnabled();

    fireEvent.click(prev);
    // Non-zero track-relative target: the track really moved off the last card.
    expect(scrollToLeft()).toBe(645);
    expect(scrollToLeft()).toBeGreaterThan(0);
    expect(counter()).toBe("2 / 3");

    // A mid-flight frame must not snap the counter back to the old card.
    track.scrollLeft = 1253;
    fireEvent.scroll(track);
    expect(counter()).toBe("2 / 3");

    track.scrollLeft = 645;
    fireEvent.scroll(track);
    fireEvent(track, new Event("scrollend"));
    expect(counter()).toBe("2 / 3");

    fireEvent.click(prev);
    expect(counter()).toBe("1 / 3");
    expect(scrollToLeft()).toBe(0);
    expect(prev).toBeDisabled();
  });

  it("focuses the paged card's action with preventScroll so the focus reveal cannot fight the snap", () => {
    const { container, carousel } = renderBatch(threeChips());
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    paintLayout(container, 328, [328, 973, 1618], 1253);

    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    focusSpy.mockClear();

    fireEvent.keyDown(carousel(), { key: "ArrowLeft" });

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByRole("button", { name: "Approve move_task new" })).toBe(document.activeElement);
  });

  it("focuses the wrapper with preventScroll when the card has no enabled action", () => {
    const decided = renderBatch([chip({ approvalId: "a1", seq: 0 }), chip({ approvalId: "a2", seq: 1, name: "move_task", state: "approved" })]);
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

    fireEvent.keyDown(decided.carousel(), { key: "ArrowRight" });

    const slide = decided.container.querySelectorAll(".approval-carousel-slide")[1]!;
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(slide);
  });

  it("settles a rapid double-click on the final card only (no intermediate counter)", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track, scrollToLeft } = paintLayout(container, 328, [328, 973, 1618], 1253);
    const next = screen.getByRole("button", { name: "Next change" });

    fireEvent.click(next);
    fireEvent.click(next);
    expect(counter()).toBe("3 / 3");
    // Two pages issued back to back; the final target wins.
    expect(scrollToLeft()).toBe(1253);

    // Intermediate frames of the in-flight smooth scroll are ignored.
    track.scrollLeft = 645;
    fireEvent.scroll(track);
    expect(counter()).toBe("3 / 3");

    track.scrollLeft = 1253;
    fireEvent.scroll(track);
    fireEvent(track, new Event("scrollend"));
    expect(counter()).toBe("3 / 3");
    expect(screen.getByRole("button", { name: "Previous change" })).toBeEnabled();
  });

  it("settle fallback does not settle on a mid-flight position (stability check)", () => {
    const { container, counter } = renderBatch(threeChips());
    const { track } = paintLayout(container, 328, [328, 973, 1618], 1253);
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Next change" }));

      track.scrollLeft = 100;
      act(() => vi.advanceTimersByTime(150));
      track.scrollLeft = 400;
      act(() => vi.advanceTimersByTime(100));

      // Still moving: the counter holds the optimistic target, never a middle card.
      expect(counter()).toBe("2 / 3");

      track.scrollLeft = 645;
      act(() => vi.advanceTimersByTime(300));
      expect(counter()).toBe("2 / 3");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Auto-advance (herald-write-approvals.html State 3b) ──

  it("advances to the next pending card after approving the active card", () => {
    const chips = threeChips();
    const { counter, rerenderChips } = renderBatch(chips);

    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
    expect(document.activeElement).toHaveAttribute("aria-label", "Approve move_task new");
  });

  it("advances to the next pending card after rejecting the active card", () => {
    const chips = threeChips();
    const { counter, rerenderChips } = renderBatch(chips);

    fireEvent.click(screen.getByRole("button", { name: "Reject create_task new" }));
    rerenderChips([{ ...chips[0]!, state: "rejected" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
  });

  it("survives an unrelated parent re-render between the decision and the terminal state", () => {
    const chips = threeChips();
    const { counter, rerenderChips } = renderBatch(chips);

    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    // A parent re-render with fresh chip identities while the decision is in
    // flight must not drop the arm.
    rerenderChips(chips.map((c) => ({ ...c })));
    expect(counter()).toBe("1 / 3");

    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);
    expect(counter()).toBe("2 / 3");
    expect(document.activeElement).toHaveAttribute("aria-label", "Approve move_task new");
  });

  it("stays put when the decision leaves no pending card", () => {
    const chips = [
      chip({ approvalId: "a1", seq: 0, state: "approved" }),
      chip({ approvalId: "a2", seq: 1, name: "move_task", state: "rejected" }),
      chip({ approvalId: "a3", seq: 2, name: "add_comment" }),
    ];
    const { counter, rerenderChips } = renderBatch(chips);
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(counter()).toBe("3 / 3");

    fireEvent.click(screen.getByRole("button", { name: "Approve add_comment new" }));
    rerenderChips([chips[0]!, chips[1]!, { ...chips[2]!, state: "approved" }]);

    expect(counter()).toBe("3 / 3");
  });

  it("wraps to the earliest pending card when none remains after the decided one", () => {
    const chips = [
      chip({ approvalId: "a1", seq: 0 }),
      chip({ approvalId: "a2", seq: 1, name: "move_task" }),
      chip({ approvalId: "a3", seq: 2, name: "add_comment", state: "rejected" }),
    ];
    const { counter, rerenderChips } = renderBatch(chips);
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(counter()).toBe("2 / 3");

    fireEvent.click(screen.getByRole("button", { name: "Approve move_task new" }));
    rerenderChips([chips[0]!, { ...chips[1]!, state: "approved" }, chips[2]!]);

    expect(counter()).toBe("1 / 3");
    expect(document.activeElement).toHaveAttribute("aria-label", "Approve create_task new");
  });

  it("does not move on Approve all / Reject all even with a per-card decision pending", () => {
    const chips = threeChips();
    const { counter, rerenderChips, onApproveAll, onRejectAll } = renderBatch(chips);
    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));

    fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
    expect(onApproveAll).toHaveBeenCalledTimes(1);
    // The batch path clears the arm; the armed chip going terminal while a2/a3
    // stay pending must NOT advance (a retained arm would land on 2 / 3).
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);
    expect(counter()).toBe("1 / 3");

    rerenderChips(chips);
    fireEvent.click(screen.getByRole("button", { name: "Reject create_task new" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    expect(onRejectAll).toHaveBeenCalledTimes(1);
    rerenderChips([{ ...chips[0]!, state: "rejected" }, chips[1]!, chips[2]!]);
    expect(counter()).toBe("1 / 3");
  });

  it("advances on a terminal error mapping (self-heal to expired)", () => {
    const chips = threeChips();
    const { counter, rerenderChips } = renderBatch(chips);

    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    rerenderChips([{ ...chips[0]!, state: "expired" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
  });

  it("a superseded attempt's late settle cannot resolve the retry's arm", async () => {
    const chips = threeChips();
    const resolvers: Array<() => void> = [];
    const { counter, rerenderChips } = renderBatch(chips, false, () => new Promise<void>((resolve) => { resolvers.push(resolve); }));

    // Two clicks in flight on the same (still pending) card: the retry re-arms.
    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    expect(resolvers).toHaveLength(2);

    // The FIRST call settles late: its stale `.then` must not mark the retry's
    // arm resolved (identity mismatch), so the chip still pending does not
    // disarm it.
    await act(async () => {
      resolvers[0]!();
    });
    rerenderChips(chips.map((c) => ({ ...c })));

    // The retry settles; the armed chip then goes terminal and advances.
    await act(async () => {
      resolvers[1]!();
    });
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
  });

  it("a click on a non-active card's button leaves an in-flight arm intact", () => {
    const chips = [
      chip({ approvalId: "a1", seq: 0 }),
      chip({ approvalId: "a2", seq: 1, name: "move_task" }),
      chip({ approvalId: "a3", seq: 2, name: "add_comment", state: "rejected" }),
    ];
    const { counter, rerenderChips } = renderBatch(chips);

    // Arm the active card, then page away so a1 is no longer the active card.
    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(counter()).toBe("3 / 3");

    // A click on the NON-active a1 must not drop the arm; a1 going terminal
    // still advances to a2.
    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
  });

  it("does not advance when the decision fails non-terminally (chip stays pending) and disarms", async () => {
    const chips = threeChips();
    let settleDecision: (() => void) | undefined;
    const decision = new Promise<void>((resolve) => {
      settleDecision = resolve;
    });
    const { counter, rerenderChips } = renderBatch(chips, false, () => decision);

    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));

    // The call settles while the armed chip is still pending — the disarm
    // point: the resolved arm is consumed, an unrelated chip change does not
    // advance the carousel.
    await act(async () => {
      settleDecision!();
    });
    rerenderChips([chips[0]!, { ...chips[1]!, state: "approved" }, chips[2]!]);
    expect(counter()).toBe("1 / 3");

    // The armed chip going terminal later must not fire the disarmed (stale)
    // arm either.
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);
    expect(counter()).toBe("1 / 3");
  });

  it("still advances under prefers-reduced-motion: reduce (instant path)", () => {
    stubMatchMedia(true);
    const chips = threeChips();
    const { counter, rerenderChips } = renderBatch(chips);

    fireEvent.click(screen.getByRole("button", { name: "Approve create_task new" }));
    rerenderChips([{ ...chips[0]!, state: "approved" }, chips[1]!, chips[2]!]);

    expect(counter()).toBe("2 / 3");
  });
});
