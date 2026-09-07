import type { WikiPageMeta } from "../../../shared/types";

export function WikiDeletePageDialog({
  page,
  pending,
  onConfirm,
  onCancel,
}: {
  page: WikiPageMeta;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <button type="button" className="dialog-overlay" onClick={onCancel} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none">
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-4"
          style={{ width: 360, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="delete-page-title"
        >
          <h3 id="delete-page-title" className="font-display text-lg font-medium text-lx-text-primary">
            Delete page
          </h3>
          <p className="text-sm text-lx-text-secondary mt-3 leading-5">
            Delete <span className="text-lx-text-primary font-medium">&lsquo;{page.title}&rsquo;</span>? This cannot be undone.
          </p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={onConfirm}
              disabled={pending}
            >
              Delete
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
