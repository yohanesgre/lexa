import { Trash2 } from "lucide-react";
import type { Swimlane } from "../../../shared/types";

export function DeleteSwimlaneDialog({ target, onClose, onDelete }: {
  target: Swimlane;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">Delete &lsquo;{target.name}&rsquo;?</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            This will unassign all tasks in this swimlane. This action cannot be undone.
          </p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" onClick={onDelete}>
              <Trash2 size={14} strokeWidth={1.5} />
              Delete
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
