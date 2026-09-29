import { describe, expect, it } from "vitest";
import { carouselOffsets, carouselTarget, nearestIndex } from "./assistant-approval-carousel";

// Reviewer-observed layout: the track's nearest positioned ancestor is the chat
// transcript, so its offsetLeft (328) is baked into every slide offsetLeft.
const TRACK_LEFT = 328;
const SLIDES = [328, 973, 1618];
const MAX_SCROLL = 1253;

describe("carouselOffsets", () => {
  it("re-bases slide offsetLeft values from the transcript origin onto the track", () => {
    expect(carouselOffsets(TRACK_LEFT, SLIDES)).toEqual([0, 645, 1290]);
  });
});

describe("carouselTarget", () => {
  const rel = carouselOffsets(TRACK_LEFT, SLIDES);

  it("pages one card at a time (one Next from card 1 lands on card 2)", () => {
    expect(carouselTarget(1, rel, MAX_SCROLL)).toBe(645);
  });

  it("clamps the last card to the scrollable end instead of overshooting", () => {
    expect(carouselTarget(2, rel, MAX_SCROLL)).toBe(MAX_SCROLL);
  });

  it("clamps out-of-range and empty input", () => {
    expect(carouselTarget(0, rel, MAX_SCROLL)).toBe(0);
    expect(carouselTarget(-3, rel, MAX_SCROLL)).toBe(0);
    expect(carouselTarget(9, rel, MAX_SCROLL)).toBe(MAX_SCROLL);
    expect(carouselTarget(1, [], MAX_SCROLL)).toBe(0);
  });

  it("does not skip the middle card on a wide track (1920px layout)", () => {
    const wide = carouselOffsets(TRACK_LEFT, [328, 2224, 4120]);
    expect(wide).toEqual([0, 1896, 3792]);
    expect(carouselTarget(1, wide, 3792)).toBe(1896);
    expect(nearestIndex(carouselTarget(1, wide, 3792), wide)).toBe(1);
  });
});

describe("nearestIndex", () => {
  const rel = carouselOffsets(TRACK_LEFT, SLIDES);

  it("reports the snapped card for a track-relative scrollLeft", () => {
    expect(nearestIndex(0, rel)).toBe(0);
    expect(nearestIndex(645, rel)).toBe(1);
    expect(nearestIndex(1290, rel)).toBe(2);
  });

  it("still reports the last card when the scroll position is clamped", () => {
    // 1253 is 37px from card 3 but 280px from card 2 — raw (un-rebased)
    // offsets reported card 2 here.
    expect(nearestIndex(MAX_SCROLL, rel)).toBe(2);
  });

  it("falls back to index 0 for an empty track", () => {
    expect(nearestIndex(500, [])).toBe(0);
  });
});
