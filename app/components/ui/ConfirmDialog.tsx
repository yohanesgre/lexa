import { useEffect, useRef, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { useOverlayFocusTrap } from "../../lib/sidebar-state";

export function ConfirmDialog({ title, body, confirmLabel, variant = "danger", onCancel, onConfirm }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: "danger" | "default";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Initial focus (Cancel, the first focusable), Tab trap, and focus return to
  // the opener when the dialog unmounts (wireframes/src/tasks.html:377).
  useOverlayFocusTrap(true, dialogRef);

  // Keep the latest cancel handler without re-running the mount effect (which
  // would re-capture and re-focus mid-dialog).
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Belt-and-suspenders for the trap's initial focus: the trap skips elements
  // with no client rects (hidden), so a dialog measured before layout still
  // lands on Cancel. Runs after the trap's mount effect, so it wins.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Esc cancels (wireframes/src/tasks.html:412); on unmount focus is restored
  // by the trap hook (the bulk bar for the tasks confirm).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog ref={dialogRef} open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">{title}</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">{body}</p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button ref={cancelRef} type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
            {variant === "danger" ? (
              <button type="button" className="btn btn-danger-solid btn-sm" onClick={onConfirm}>
                <Trash2 size={14} strokeWidth={1.5} />
                {confirmLabel}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>
                {confirmLabel}
              </button>
            )}
          </div>
        </dialog>
      </div>
    </>
  );
}
