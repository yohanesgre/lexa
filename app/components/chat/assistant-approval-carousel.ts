// Carousel geometry for the approval batch — pure value helpers. The component
// owns refs/state and feeds measured layout in.

// A slide's offsetLeft is measured from its nearest POSITIONED ancestor. The
// scrolling track itself is not positioned, so that ancestor is the chat
// transcript, while scrollLeft is track-relative: raw offsets carry the track's
// own offset as a constant shift. Subtracting it puts every slide on the scroll
// coordinate system (without this, paging overshoots and N / M is wrong).
export function carouselOffsets(trackOffsetLeft: number, slideOffsetLefts: readonly number[]): number[] {
  return slideOffsetLefts.map((offset) => offset - trackOffsetLeft);
}

// Scroll position that shows card `index`, clamped to the scrollable range so
// the last card lands on the end instead of overshooting it.
export function carouselTarget(index: number, relOffsets: readonly number[], maxScroll: number): number {
  if (relOffsets.length === 0) return 0;
  const i = Math.max(0, Math.min(relOffsets.length - 1, index));
  return Math.max(0, Math.min(Math.max(0, maxScroll), relOffsets[i]!));
}

// Index of the card closest to `scrollLeft` — the snapped card after a swipe or
// a programmatic page.
export function nearestIndex(scrollLeft: number, relOffsets: readonly number[]): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  relOffsets.forEach((offset, i) => {
    const dist = Math.abs(offset - scrollLeft);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
