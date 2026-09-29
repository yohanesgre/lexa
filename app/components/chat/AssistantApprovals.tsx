import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AssistantWriteDiff } from "../../../shared/assistant";
import { ApprovalChipRow } from "./AssistantApprovalChipRow";
import { carouselOffsets, carouselTarget, nearestIndex } from "./assistant-approval-carousel";

// Approval batch for Assistant write proposals — transcribed from
// wireframes/src/herald-write-approvals.html. Chips render in seq order under
// ONE batch header as a horizontal scroll-snapped carousel: one active card,
// the neighbour peeking, prev/next controls + an N / M counter (the per-chip
// seq badge folds into the counter). Native scroll-snap does the paging; this
// layer adds ArrowLeft / ArrowRight paging, clamped ends, and the focused-card
// follow. Chip internals live in AssistantApprovalChipRow / AssistantDiffBody.

export type ApprovalChipState = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface ApprovalChip {
  approvalId: string;
  batchId: string;
  seq: number;
  name: string;
  detail?: string | undefined;
  diff: AssistantWriteDiff;
  state: ApprovalChipState;
  error?: { code: string; message: string };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AssistantApprovalBatch({
  chips,
  locked,
  onDecide,
  onApproveAll,
  onRejectAll,
}: {
  chips: ApprovalChip[];
  locked: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
}) {
  const ordered = chips.toSorted((a, b) => a.seq - b.seq);
  const total = ordered.length;
  const pendingCount = ordered.filter((c) => c.state === "pending").length;
  const decidedCount = total - pendingCount;

  // Header keeps the proposal title and adds the decided/pending tally once any
  // card is decided (wireframe: title AND tally together).
  const tallyParts: string[] = [];
  for (const key of ["approved", "rejected", "expired", "failed", "pending"] as const) {
    const n = ordered.filter((c) => c.state === key).length;
    if (n > 0) tallyParts.push(`${n} ${key}`);
  }

  const [activeIndex, setActiveIndex] = useState(0);
  const active = total === 0 ? 0 : Math.min(activeIndex, total - 1);

  const trackRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);

  // A smooth programmatic page emits a scroll frame per animation tick, so a
  // naive nearest-card sync would step the N / M counter and the prev/next
  // disabled states through every intermediate card. Suspend scroll sync while
  // a page is in flight and re-sync once it settles (`scrollend`, with a
  // stability-checked timeout fallback for engines where that event is missing
  // or a slow smooth scroll outlives a single fixed delay).
  const scrollingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const scrollEndRef = useRef<(() => void) | null>(null);

  function settleScroll() {
    const track = trackRef.current;
    if (!track) return;
    scrollingRef.current = false;
    const best = nearestIndex(track.scrollLeft, trackRelOffsets());
    setActiveIndex((cur) => (cur === best ? cur : best));
  }

  // Drop whichever settle watcher is currently armed (scrollend listener +
  // fallback timer) so a new page cannot leave the previous listener piled up
  // on the track.
  function disarmSettle() {
    const track = trackRef.current;
    if (track && scrollEndRef.current) track.removeEventListener("scrollend", scrollEndRef.current);
    scrollEndRef.current = null;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function finishSettle() {
    disarmSettle();
    if (scrollingRef.current) settleScroll();
  }

  function armScrollSettle() {
    const track = trackRef.current;
    if (!track) return;
    disarmSettle();
    scrollingRef.current = true;

    const onScrollEnd = () => finishSettle();
    scrollEndRef.current = onScrollEnd;
    track.addEventListener("scrollend", onScrollEnd, { once: true });

    // Fallback: settle only once scrollLeft is unchanged across consecutive
    // checks — a slow smooth scroll can outlive a fixed delay, and settling on
    // a mid-flight position would ratchet the counter through the middle. Hard
    // cap keeps a stuck/never-quiet track from suspending sync forever.
    const startedAt = Date.now();
    let lastLeft = track.scrollLeft;
    let stableChecks = 0;
    const poll = () => {
      settleTimerRef.current = null;
      if (!scrollingRef.current) return;
      const left = track.scrollLeft;
      if (left === lastLeft) stableChecks += 1;
      else {
        stableChecks = 0;
        lastLeft = left;
      }
      if (stableChecks >= 2 || Date.now() - startedAt >= 2000) {
        finishSettle();
        return;
      }
      settleTimerRef.current = window.setTimeout(poll, 100);
    };
    settleTimerRef.current = window.setTimeout(poll, 100);
  }

  useEffect(
    () => () => {
      disarmSettle();
    },
    []
  );

  // Slides carry the transcript's offset (the track is not positioned), so the
  // measured offsets must be re-based onto the track before they are compared
  // with scrollLeft or handed to scrollTo.
  function trackRelOffsets(): number[] {
    const track = trackRef.current;
    if (!track) return [];
    return carouselOffsets(
      track.offsetLeft,
      slideRefs.current.map((slide) => (slide ? slide.offsetLeft : 0))
    );
  }

  // Page to a card: clamp at the ends (no wrap), scroll it into view (instant
  // under reduced motion), then land focus on the card's first enabled action
  // button — or the card wrapper when the card is fully decided / disabled.
  function goTo(index: number, focus: boolean) {
    const next = Math.max(0, Math.min(total - 1, index));
    setActiveIndex(next);
    const track = trackRef.current;
    const slide = slideRefs.current[next];
    if (track && slide && typeof track.scrollTo === "function") {
      try {
        const maxScroll = track.scrollWidth - track.clientWidth;
        track.scrollTo({ left: carouselTarget(next, trackRelOffsets(), maxScroll), behavior: prefersReducedMotion() ? "auto" : "smooth" });
        armScrollSettle();
      } catch {
        // jsdom has no layout/scroll — the counter state is the assertion.
      }
    }
    if (focus && slide) {
      // Wireframe (herald-write-approvals.html:238): focus lands on the newly
      // active card's Approve button, not DOM-first (which would be Reject).
      // preventScroll: the browser's focus reveal must not scroll the track —
      // under `scroll-snap-type: x mandatory` that reveal can fall short of the
      // snap midpoint on a BACKWARD page (the Approve button sits right of
      // centre), so mandatory snap returns the track to the old card and the
      // page no-ops. Only the explicit track.scrollTo above may move the track.
      const action =
        slide.querySelector<HTMLButtonElement>('button:not([disabled])[aria-label^="Approve "]') ??
        slide.querySelector<HTMLButtonElement>("button:not([disabled])");
      if (action) action.focus({ preventScroll: true });
      else slide.focus({ preventScroll: true });
    }
  }

  // Track the snapped card for swipes; skipped mid-page so the counter does not
  // ratchet through intermediate cards (see armScrollSettle above).
  function handleScroll() {
    const track = trackRef.current;
    if (!track) return;
    if (scrollingRef.current) return;
    const best = nearestIndex(track.scrollLeft, trackRelOffsets());
    setActiveIndex((cur) => (cur === best ? cur : best));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    goTo(active + (e.key === "ArrowRight" ? 1 : -1), true);
  }

  return (
    <div className="approval-batch">
      <div className="flex items-center justify-between" style={{ marginBottom: 8, gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <span className="text-sm font-medium text-lx-text-primary">
            Assistant proposes <span className="font-mono">{total}</span> change{total === 1 ? "" : "s"}
          </span>
          {decidedCount > 0 && (
            <div className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {tallyParts.join(" · ")}
            </div>
          )}
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
            <button type="button" className="btn btn-danger btn-sm" disabled={locked} onClick={onRejectAll}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              Reject all
            </button>
            <button type="button" className="btn btn-ghost-accent btn-sm" disabled={locked} onClick={onApproveAll}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Approve all
            </button>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="approval-carousel" onKeyDown={handleKeyDown}>
          <div
            ref={trackRef}
            className="approval-carousel-track"
            role="group"
            aria-roledescription="carousel"
            aria-label={`Assistant proposes ${total} change${total === 1 ? "" : "s"}`}
            onScroll={handleScroll}
          >
            {ordered.map((chip, i) => (
              <div
                key={chip.approvalId}
                ref={(el) => {
                  slideRefs.current[i] = el;
                }}
                className="approval-carousel-slide"
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${total}`}
                tabIndex={-1}
              >
                <ApprovalChipRow chip={chip} disabled={locked} onDecide={onDecide} />
              </div>
            ))}
          </div>

          <div className="approval-carousel-controls">
            <button type="button" className="btn btn-ghost btn-icon-sm" disabled={active === 0} aria-label="Previous change" onClick={() => goTo(active - 1, true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="approval-carousel-count" aria-live="polite">
              {active + 1} / {total}
            </span>
            <button type="button" className="btn btn-ghost btn-icon-sm" disabled={active === total - 1} aria-label="Next change" onClick={() => goTo(active + 1, true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SuspendedIndicator() {
  return (
    <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
      <span className="suspended-dot" />
      <span className="font-micro text-2xs text-lx-text-warning" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
        Waiting for your approval…
      </span>
    </div>
  );
}
