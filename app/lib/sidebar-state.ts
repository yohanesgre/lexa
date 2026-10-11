// Unified collapse/expand state for every wiki sidebar and surface pane.
//
// SSR (and the hydration render) always renders every panel CLOSED — a
// hydration gate keeps `open`/`overlayActive` false until the client store is
// live, so first paint never shows an overlay. After hydration the client
// applies the stored desktop intent (`storageKey` in localStorage) at ≥768px,
// or the ephemeral, always-closed-on-entry mobile flag below it. The
// breakpoint is a live `matchMedia` subscription (both directions), not a
// mount snapshot.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { hasMatchMedia } from "./viewport";

export interface UseSidebarStateOptions {
  storageKey: string;
  defaultOpen: boolean;
  breakpoint?: number;
  /** Persisted strings for the two states (default `"true"` / `"false"`). The
   *  surface panes store `"open"` / `"closed"` so the cap band's pane toggle
   *  reads the same value it writes. */
  storageValues?: { open: string; closed: string } | undefined;
  /** Pane name (`threads` / `wiki`). When set, every open-state change
   *  dispatches `lexa:pane-state` with `{ surface, open }`, which is how the
   *  cap band's toggle keeps its `aria-expanded` in sync. */
  surface?: string | undefined;
  /** Window event that toggles this state — the cap band's pane toggle. */
  toggleEvent?: string | undefined;
  /** Above this width the state is always open and cannot be closed: the
   *  surface panes are part of the shell on big screens, drawers below it. */
  alwaysOpenAbove?: number | undefined;
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

function readStoredOpen(key: string, values: { open: string; closed: string }): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === values.open) return true;
    if (raw === values.closed) return false;
  } catch {
    // Private-mode / disabled storage — fall back to the panel default.
  }
  return null;
}

function writeStoredOpen(key: string, value: boolean, values: { open: string; closed: string }): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? values.open : values.closed);
  } catch {
    // Ignore write failures; the in-memory store still updates.
  }
  notifyStorage(key);
}

export function useSidebarState({
  storageKey,
  defaultOpen,
  breakpoint = 768,
  storageValues,
  surface,
  toggleEvent,
  alwaysOpenAbove,
}: UseSidebarStateOptions): SidebarState {
  // Primitive values, so the store callbacks below stay referentially stable
  // across renders even though the option is an object literal at every call.
  const openValue = storageValues?.open ?? "true";
  const closedValue = storageValues?.closed ?? "false";
  const values = useMemo(() => ({ open: openValue, closed: closedValue }), [openValue, closedValue]);

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

  // Above `alwaysOpenAbove` the state is open by construction (the surface
  // panes are part of the shell there, not a drawer).
  const forcedQuery = `(min-width: ${alwaysOpenAbove ?? 999999}px)`;
  const subscribeForced = useCallback(
    (onChange: () => void) => subscribeMedia(forcedQuery, onChange),
    [forcedQuery]
  );
  const getForcedSnapshot = useCallback(() => mediaSnapshot(forcedQuery), [forcedQuery]);
  const forcedOpen = useSyncExternalStore(subscribeForced, getForcedSnapshot, () => false);

  const subscribeStorageForKey = useCallback(
    (onChange: () => void) => subscribeStorage(storageKey, onChange),
    [storageKey]
  );
  const getStorageSnapshot = useCallback(
    () => readStoredOpen(storageKey, values) ?? defaultOpen,
    [storageKey, defaultOpen, values]
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
    (value: boolean) => writeStoredOpen(storageKey, value, values),
    [storageKey, values]
  );

  const toggle = useCallback(() => {
    if (forcedOpen) return;
    if (isDesktop) setDesktopOpen(!desktopOpen);
    else setMobileOpen((value) => !value);
  }, [forcedOpen, isDesktop, desktopOpen, setDesktopOpen]);

  const open = hydrated && (forcedOpen ? true : isDesktop ? desktopOpen : mobileOpen);

  // The cap band's pane toggle is a separate component from the pane it opens
  // (it lives in the shell), so the pane publishes each state change instead of
  // the toggle guessing from storage.
  useEffect(() => {
    if (!surface) return;
    window.dispatchEvent(new CustomEvent("lexa:pane-state", { detail: { surface, open } }));
  }, [surface, open]);

  useEffect(() => {
    if (!toggleEvent) return;
    window.addEventListener(toggleEvent, toggle);
    return () => window.removeEventListener(toggleEvent, toggle);
  }, [toggleEvent, toggle]);

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
//
// `getExtraContainers` extends the trap with nodes that live OUTSIDE the
// container because they are portaled (e.g. a DatePicker popover appended to
// document.body). Without it, Tab cannot leave the container for the portal
// and the trap wraps back to its own first item. The callback is read on each
// keydown (not captured at mount), so a popover opened after the trap is
// picked up live. Within a group native DOM order still drives Tab; the trap
// only owns the boundaries between groups and the overall wrap.
export function useOverlayFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  suppressReturnFocusRef?: React.RefObject<boolean>,
  getExtraContainers?: () => Array<HTMLElement | null>
): void {
  const getExtraContainersRef = useRef(getExtraContainers);
  getExtraContainersRef.current = getExtraContainers;

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
      const extras = (getExtraContainersRef.current?.() ?? []).filter(
        (el): el is HTMLElement => el !== null && el.isConnected
      );
      const groups = [node, ...extras]
        .map((root) => focusableWithin(root))
        .filter((items) => items.length > 0);
      const items = groups.flatMap((group) => group);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      for (let gi = 0; gi < groups.length; gi += 1) {
        const group = groups[gi]!;
        const pos = current ? group.indexOf(current) : -1;
        if (pos === -1) continue;
        if (!event.shiftKey) {
          if (pos === group.length - 1) {
            event.preventDefault();
            const next = groups[gi + 1] ?? groups[0]!;
            next[0]!.focus();
          }
        } else if (pos === 0) {
          event.preventDefault();
          const prev = groups[gi - 1] ?? groups[groups.length - 1]!;
          prev[prev.length - 1]!.focus();
        }
        return;
      }
      event.preventDefault();
      (event.shiftKey ? items[items.length - 1]! : items[0]!).focus();
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
