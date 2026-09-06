// Body scroll lock for overlays. The body gets `data-scroll-lock="true"`
// while at least one overlay is engaged. It is NOT a hook — call
// `lockScroll(active)` inside a `useEffect` and return its result as the
// effect's cleanup:
//   useEffect(() => lockScroll(menuOpen), [menuOpen]);
// The lock is harmless on touch devices (the overlay's own overflow
// handles scrolling).

let activeLocks = 0;

function applyLock(): void {
  if (typeof document === "undefined") return;
  if (activeLocks === 0) {
    document.body.setAttribute("data-scroll-lock", "true");
  }
  activeLocks += 1;
}

function releaseLock(): void {
  if (typeof document === "undefined") return;
  activeLocks = Math.max(0, activeLocks - 1);
  if (activeLocks === 0) {
    document.body.removeAttribute("data-scroll-lock");
  }
}

/**
 * Lock body scroll while `active` is true. Reuses a single counter across
 * concurrent overlays so the body only unlocks when the last overlay
 * closes. Returns a cleanup function. Call from a `useEffect` (a `use*`
 * name would trip React's rules-of-hooks linters — it takes no hooks).
 */
export function lockScroll(active: boolean): () => void {
  if (!active || typeof document === "undefined") return () => {};
  applyLock();
  return releaseLock;
}

