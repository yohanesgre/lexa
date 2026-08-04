import { X } from "lucide-react";
import { TrashIcon } from "./icons";
import type { Task } from "../../shared/types";

interface DeleteTaskDialogProps {
  task: Task;
  open: boolean;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
}

export function DeleteTaskDialog({ task, open, deleting, onClose, onDelete }: DeleteTaskDialogProps) {
  if (!open) return null;
  return (
<>
  <button type="button" className="dialog-overlay" onClick={onClose} aria-label="Close" />
  <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
    <dialog open
      className="dialog dialog-enter"
      aria-modal="true"
      aria-labelledby="delete-task-title"
    >
      <div className="flex items-center gap-2">
        <TrashIcon size={18} className="text-lx-text-danger" />
        <h3
          id="delete-task-title"
          className="font-display text-lg font-medium text-lx-text-primary"
        >
          Delete task
        </h3>
      </div>
      <p className="text-sm text-lx-text-secondary mt-3 leading-5">
        Delete <span className="text-lx-text-primary font-medium">&lsquo;{task.title}&rsquo;</span>? This cannot
        be undone.
      </p>
      <div className="flex items-center gap-2 mt-4 justify-end">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger-solid"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </dialog>
  </div>
</>
  );
}
