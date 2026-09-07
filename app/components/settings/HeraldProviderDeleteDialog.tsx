import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { useDeleteProvider } from "../../lib/queries/herald-admin";

// Delete confirmation dialog (portal). Deleting a provider leaves projects
// referencing it failing 409 until reassigned — hence the hard confirm.
export function HeraldProviderDeleteDialog({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const del = useDeleteProvider();
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <button type="button" className="dialog-overlay" onClick={onClose} aria-label="Close" />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <div className="dialog dialog-enter pointer-events-auto" style={{ maxWidth: 420 }}>
          <h3 className="font-display text-base font-medium text-lx-text-primary">Delete provider?</h3>
          <p className="text-sm text-lx-text-secondary mt-2">This will permanently delete the provider. Projects referencing it will fail with 409 until reassigned.</p>
          <div className="flex items-center gap-2 mt-4 justify-end">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-danger-solid" disabled={del.isPending} onClick={() => del.mutate(providerId, { onSuccess: onClose })}><Trash2 size={14} strokeWidth={1.5} /> {del.isPending ? "Deleting…" : "Delete"}</button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
