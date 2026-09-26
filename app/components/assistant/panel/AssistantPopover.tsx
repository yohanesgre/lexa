import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { AssistantPanel } from "./AssistantPanel";
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
}

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
  if (!anchorRect) return {};
  return {
    position: "fixed",
    top: popoverTop,
    left: Math.min(Math.max(8, anchorRect.left), (typeof window !== "undefined" ? window.innerWidth : 0) - 348),
    zIndex: 80,
    width: 340,
  };
}

// Document-level outside click + Escape dismiss for the open popover.
function useOutsideDismiss(open: boolean, onClose: () => void, containerRef: React.RefObject<HTMLDivElement | null>) {
  const onOutsideClick = useEffectEvent((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      onClose();
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

export function AssistantPopover({ editor, slug, documentType, documentId, open, onClose, onReview, reviewActive, appliedTaskId, rejectedTaskId, anchorRect }: AssistantPopoverProps) {
  // Hydration-safe portal target: SSR and the first client render both see
  // null, the browser switches to document.body after hydration.
  const portalTarget = useSyncExternalStore(
    () => () => {},
    () => document.body,
    () => null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(open, onClose, containerRef);
  const popoverTop = usePopoverPosition(open, anchorRect, containerRef);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div ref={containerRef} className="menu-popover" data-assistant-popover style={computePopoverStyle(anchorRect, popoverTop)}>
      <AssistantPanel
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
