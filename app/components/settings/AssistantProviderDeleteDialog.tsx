import { useDeleteProvider } from "../../lib/queries/assistant-admin";
import { ConfirmDialog } from "../ui/ConfirmDialog";

// Delete confirmation dialog. Deleting a provider leaves projects
// referencing it failing 409 until reassigned — hence the hard confirm.
// Uses the shared ConfirmDialog so Escape/initial focus/modal semantics are
// handled once (audit LX-99).
export function AssistantProviderDeleteDialog({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const del = useDeleteProvider();

  return (
    <ConfirmDialog
      title="Delete provider?"
      body="This will permanently delete the provider. Reassign its projects first, or they'll stop working."
      confirmLabel="Delete"
      onCancel={onClose}
      onConfirm={() => {
        if (del.isPending) return;
        del.mutate(providerId, { onSuccess: onClose });
      }}
    />
  );
}
