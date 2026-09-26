// Unified collapse/expand state for every wiki sidebar.
//
// SSR (and the hydration render) always renders every panel CLOSED — a
// hydration gate keeps `open`/`overlayActive` false until the client store is
// live, so first paint never shows an overlay. After hydration the client
// applies the stored desktop intent (`storageKey` in localStorage) at ≥768px,
// or the ephemeral, always-closed-on-entry mobile flag below it. The
// breakpoint is a live `matchMedia` subscription (both directions), not a
// mount snapshot.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { hasMatchMedia } from "./viewport";

export interface UseSidebarStateOptions {
  storageKey: string;
  defaultOpen: boolean;
  breakpoint?: number;
}

export interface SidebarState {
  open: boolean;
  toggle: () => void;
  isDesktop: boolean;
  overlayActive: boolean;
}

function getMediaQueryList(query: string): MediaQueryList | null {
  if (!hasMatchMedia()) return null;
  return window.matchMedia(query);
}

function subscribeMedia(query: string, onChange: () => void): () => void {
  const mql = getMediaQueryList(query);
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function mediaSnapshot(query: string): boolean {
  const mql = getMediaQueryList(query);
  return mql ? mql.matches : true;
}

const noopSubscribe = () => () => {};
const getHydratedSnapshot = () => true;
const getHydratedServerSnapshot = () => false;

type StorageListener = () => void;
const storageListeners = new Map<string, Set<StorageListener>>();

function subscribeStorage(key: string, listener: StorageListener): () => void {
  let listeners = storageListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    storageListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) storageListeners.delete(key);
  };
}

function notifyStorage(key: string): void {
  storageListeners.get(key)?.forEach((listener) => listener());
}

function readStoredOpen(key: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Private-mode / disabled storage — fall back to the panel default.
  }
  return null;
}

function writeStoredOpen(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Ignore write failures; the in-memory store still updates.
  }
  notifyStorage(key);
}

export function useSidebarState({
  storageKey,
  defaultOpen,
  breakpoint = 768,
}: UseSidebarStateOptions): SidebarState {
  const query = `(min-width: ${breakpoint}px)`;
  const subscribeMediaForQuery = useCallback(
    (onChange: () => void) => subscribeMedia(query, onChange),
    [query]
  );
  const getMediaSnapshot = useCallback(() => mediaSnapshot(query), [query]);
  const isDesktop = useSyncExternalStore(
    subscribeMediaForQuery,
    getMediaSnapshot,
    () => true
  );

  const subscribeStorageForKey = useCallback(
    (onChange: () => void) => subscribeStorage(storageKey, onChange),
    [storageKey]
  );
  const getStorageSnapshot = useCallback(
    () => readStoredOpen(storageKey) ?? defaultOpen,
    [storageKey, defaultOpen]
  );
  const getStorageServerSnapshot = useCallback(() => defaultOpen, [defaultOpen]);
  const desktopOpen = useSyncExternalStore(
    subscribeStorageForKey,
    getStorageSnapshot,
    getStorageServerSnapshot
  );

  const [mobileOpen, setMobileOpen] = useState(false);

  // Hydration gate. The media + storage stores render their SSR snapshot
  // (desktop, `defaultOpen`) until the client store takes over. Until then
  // every panel renders closed so first paint never shows an overlay — a
  // phone must not paint the open fixed panel before the client corrects it.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    getHydratedSnapshot,
    getHydratedServerSnapshot
  );

  // Entering mobile closes the overlay; desktop intent stays in storage.
  useEffect(() => {
    if (!isDesktop) setMobileOpen(false);
  }, [isDesktop]);

  const setDesktopOpen = useCallback(
    (value: boolean) => writeStoredOpen(storageKey, value),
    [storageKey]
  );

  const toggle = useCallback(() => {
    if (isDesktop) setDesktopOpen(!desktopOpen);
    else setMobileOpen((value) => !value);
  }, [isDesktop, desktopOpen, setDesktopOpen]);

  const open = hydrated && (isDesktop ? desktopOpen : mobileOpen);

  return {
    open,
    toggle,
    isDesktop,
    overlayActive: hydrated && !isDesktop && open,
  };
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0
  );
}

// The panel toggle unmounts when its panel opens, so the element focused at
// open time is gone (or body) by close. Prefer a captured element that still
// exists, otherwise resolve the panel's own `[aria-controls][aria-expanded=false]`
// trigger — the rail toggle remounted in the same commit as the close.
function resolveReturnFocus(
  panelId: string,
  captured: HTMLElement | null
): HTMLElement | null {
  if (captured && captured !== document.body && captured.isConnected) return captured;
  if (panelId) {
    const trigger = document.querySelector<HTMLElement>(
      `[aria-controls="${panelId}"][aria-expanded="false"]`
    );
    if (trigger) return trigger;
  }
  return null;
}

// Dialog focus management for a sidebar overlay: move focus into the panel on
// open, trap Tab/Shift+Tab inside it, and return focus to the panel's rail
// toggle on close. Inactive on desktop, where the panel is inline. The repo has
// no existing focus-trap utility — this is the local one.
//
// `suppressReturnFocusRef` lets a dismissal that was itself a focus move (an
// outside mousedown targeting another control) skip the return-focus restore,
// so closing the panel never yanks focus back to its trigger. Programmatic
// dismissals (Esc / scrim / row select) leave it false and still restore.
export function useOverlayFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  suppressReturnFocusRef?: React.RefObject<boolean>
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const panelId = container?.id ?? "";
    const captured = document.activeElement as HTMLElement | null;

    const initial = container ? focusableWithin(container) : [];
    if (initial.length > 0) initial[0]!.focus();
    else container?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const node = containerRef.current;
      if (!node) return;
      const items = focusableWithin(node);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !node.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (current === last || !node.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const suppress = suppressReturnFocusRef?.current ?? false;
      if (suppressReturnFocusRef) suppressReturnFocusRef.current = false;
      if (!suppress) resolveReturnFocus(panelId, captured)?.focus();
    };
  }, [active, containerRef, suppressReturnFocusRef]);
}
