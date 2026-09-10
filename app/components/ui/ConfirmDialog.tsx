import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";

export function ConfirmDialog({ title, body, confirmLabel, variant = "danger", onCancel, onConfirm }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  variant?: "danger" | "default";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <button type="button" className="slideover-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Dialog">
          <h2 className="font-display text-lg font-medium text-lx-text-primary">{title}</h2>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">{body}</p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
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
