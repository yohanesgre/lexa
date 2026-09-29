import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { AssistantPanel } from "./AssistantPanel";
import { assistantPanelSessionKey } from "./assistant-panel-store";
import type { AssistantReviewIdentity } from "../../../lib/useAssistantReview";

// The editor Generate popover is the assistant-only surface
// (wireframes/src/herald-popover.html): skill picker, provider empty state,
// streaming preview + Stop, tool chips, Done (Reject / Review in editor),
// Failed (code + Retry). No engine toggle, runtime picker, or session line.

export interface AssistantPopoverProps {
  editor: Editor;
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  open: boolean;
  onClose: () => void;
  onReview: (text: string, identity: AssistantReviewIdentity) => void;
  reviewActive: boolean;
  // Task id accepted in the review banner this session — terminal state, so
  // the result is never offered for insert again (prevents duplicates).
  appliedTaskId?: string | null | undefined;
  // Task id rejected in the editor review surface this session — terminal
  // state, so the result isn't re-offered when the popover reopens.
  rejectedTaskId?: string | null | undefined;
  anchorRect: DOMRect | null;
  // The button that toggles the popover — an outside mousedown on it must not
  // close the popover before the click handler gets to toggle it.
  triggerRef?: React.RefObject<HTMLElement | null> | undefined;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Prefer anchoring below the button; flip above when it doesn't fit there;
// as a last resort pin it inside the viewport so the controls stay reachable
// either way.
function computePopoverTop(anchorRect: DOMRect | null, height: number): number {
  const belowTop = (anchorRect?.bottom ?? 8) + 6;
  const aboveTop = (anchorRect?.top ?? 8) - height - 6;
  const fitsBelow = belowTop >= 8 && belowTop + height <= window.innerHeight - 8;
  const fitsAbove = aboveTop >= 8 && aboveTop + height <= window.innerHeight - 8;
  if (fitsBelow) return belowTop;
  if (fitsAbove) return aboveTop;
  return Math.max(8, Math.min(belowTop, window.innerHeight - 8 - height));
}

function computePopoverStyle(anchorRect: DOMRect | null, popoverTop: number): React.CSSProperties {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
  // No anchor (e.g. an anchor detached mid-render): still pin to a clamped
  // fixed position rather than dropping back to static layout.
  const left = anchorRect ? Math.min(Math.max(8, anchorRect.left), viewportWidth - 348) : 8;
  return {
    position: "fixed",
    top: popoverTop,
    left,
    zIndex: 80,
    width: 340,
  };
}

// Document-level outside click + Escape dismiss for the open popover. A
// mousedown on the trigger is ignored here: the trigger's own click handler
// toggles the popover, and closing on the mousedown would race it into a
// remount (state loss).
function useOutsideDismiss(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLDivElement | null>,
  triggerRef?: React.RefObject<HTMLElement | null> | undefined,
  onOutsideDismiss?: (() => void) | undefined
) {
  const onOutsideClick = useEffectEvent((e: MouseEvent) => {
    const target = e.target as Node | null;
    if (triggerRef?.current && target && triggerRef.current.contains(target)) return;
    if (target instanceof Element && target.closest("[data-assistant-trigger]")) return;
    if (containerRef.current && target && !containerRef.current.contains(target)) {
      (onOutsideDismiss ?? onClose)();
    }
  });
  const onDocumentKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  });
  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open]);
}

// The popover grows with task state (running preview, buttons) and the anchor
// can sit low — or off-screen — when the editor is deep in a scrollable
// slideover. Without clamping the picker rows can end up below the fold,
// unreachable. Clamp the left edge too.
function usePopoverPosition(open: boolean, anchorRect: DOMRect | null, containerRef: React.RefObject<HTMLDivElement | null>) {
  const [popoverTop, setPopoverTop] = useState(0);
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const top = computePopoverTop(anchorRect, containerRef.current.offsetHeight);
    setPopoverTop((prev) => (prev === top ? prev : top));
  });
  return popoverTop;
}

export function AssistantPopover({ editor, slug, documentType, documentId, open, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId, anchorRect, triggerRef }: AssistantPopoverProps) {
  // Hydration-safe portal target: SSR and the first client render both see
  // null, the browser switches to document.body after hydration.
  const portalTarget = useSyncExternalStore(
    () => () => {},
    () => document.body,
    () => null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  // Light dismiss (outside mousedown) must not yank focus back from wherever
  // the user just clicked; Escape and unmount still restore the opener.
  const dismissOnOutside = () => {
    restoreFocusRef.current = false;
    onClose();
  };
  useOutsideDismiss(open, onClose, containerRef, triggerRef, dismissOnOutside);
  const popoverTop = usePopoverPosition(open, anchorRect, containerRef);

  // Dialog focus management: remember the opener, move focus into the panel
  // (the idle textarea autofocuses itself), restore the opener on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = true;
    const container = containerRef.current;
    const active = document.activeElement as HTMLElement | null;
    // A child effect (AssistantPanelIdle autofocus) may already have moved
    // focus inside the portal — passive effects run child-first, so only a
    // focus that arrived from outside is the opener worth restoring.
    if (active && !(container && container.contains(active))) {
      previouslyFocusedRef.current = active;
    }
    if (container && !(active && container.contains(active))) container.focus();
    return () => {
      // Fall back to the trigger: the captured opener can be inside the
      // portal (already removed) when the idle form autofocused.
      const previous = previouslyFocusedRef.current ?? triggerRef?.current ?? null;
      previouslyFocusedRef.current = null;
      if (restoreFocusRef.current && previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open || !portalTarget) return null;

  // Keep Tab inside the non-modal popover while it is open.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === container)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Assistant"
      tabIndex={-1}
      className="menu-popover"
      data-assistant-popover
      style={computePopoverStyle(anchorRect, popoverTop)}
      onKeyDown={onKeyDown}
    >
      <AssistantPanel
        key={assistantPanelSessionKey(slug, documentType, documentId)}
        editor={editor}
        slug={slug}
        documentType={documentType}
        documentId={documentId}
        onClose={onClose}
        onReview={onReview}
        reviewActive={reviewActive}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
      />
    </div>,
    portalTarget
  );
}
