// Body scroll lock for overlays. The body gets `data-scroll-lock="true"`
// while at least one overlay is engaged. Components call
// `useScrollLock(active)` with `active` set to the overlay's open state —
// no need to track the DOM element. The lock is harmless on touch
// devices (the overlay's own overflow handles scrolling).
//
// On desktop with a mouse: locks regardless of pointer position, so wheel
// events outside the overlay also don't scroll the page. Standard modal
// pattern.

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
 * closes. Returns a cleanup function (also runs on unmount).
 */
export function useScrollLock(active: boolean): () => void {
  if (!active || typeof document === "undefined") return () => {};
  applyLock();
  return releaseLock;
}

