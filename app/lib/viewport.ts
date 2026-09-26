// Viewport media queries in one browser-safe place. Components call these
// instead of touching `window.matchMedia` directly — keeps render code free
// of browser-global branches (SSR renders these as desktop defaults; the
// client corrects in effects where it matters).

import { useSyncExternalStore } from "react";

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

// Overlay panels (OutlinePanel, PageSettingsPanel) render as a bottom sheet
// below 768px and as an anchored popover above it. The store subscription
// keeps the flag live across breakpoint changes; SSR renders desktop.
export const MOBILE_PANEL_QUERY = "(max-width: 767.98px)";

function subscribeMobilePanel(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = window.matchMedia(MOBILE_PANEL_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useMobilePanel(): boolean {
  return useSyncExternalStore(
    subscribeMobilePanel,
    () => matchMedia(MOBILE_PANEL_QUERY),
    () => false
  );
}
