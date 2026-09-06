// Viewport media queries in one browser-safe place. Components call these
// instead of touching `window.matchMedia` directly — keeps render code free
// of browser-global branches (SSR renders these as desktop defaults; the
// client corrects in effects where it matters).

export function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

export function matchMedia(query: string): boolean {
  return hasMatchMedia() ? window.matchMedia(query).matches : false;
}

export function isMobileViewport(): boolean {
  return matchMedia("(max-width: 899.98px)");
}

export function isNarrowViewport(): boolean {
  return matchMedia("(max-width: 767px)");
}
