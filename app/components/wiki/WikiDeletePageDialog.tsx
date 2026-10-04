import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { WikiPageMeta } from "../../../shared/types";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";

export function WikiDeletePageDialog({
  page,
  pending,
  hasChildren,
  onConfirm,
  onCancel,
}: {
  page: WikiPageMeta;
  pending: boolean;
  hasChildren: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  // wireframes/src/wiki-page-menu.html:96 — initial focus inside, focus trapped
  // while open, focus returned to the originating row on close.
  useOverlayFocusTrap(true, dialogRef);

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancelRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
        <dialog
          ref={dialogRef}
          open
          className="dialog dialog-enter pointer-events-auto p-4"
          style={{ maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="delete-page-title"
        >
          <h2 id="delete-page-title" className="font-display text-lg font-medium text-lx-text-primary">
            Delete page
          </h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Delete <span className="text-lx-text-primary font-medium">&lsquo;{page.title}&rsquo;</span>? This cannot be undone.
          </p>
          {hasChildren && (
            <p className="text-sm text-lx-text-danger mt-2 leading-5">
              This page has child pages. Delete or move them first.
            </p>
          )}
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={onConfirm}
              disabled={pending || hasChildren}
            >
              <Trash2 size={14} strokeWidth={1.5} />
              Delete
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
