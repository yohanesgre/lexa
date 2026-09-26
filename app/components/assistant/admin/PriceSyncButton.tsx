import { useSyncPrices } from "../../../lib/queries/assistant-admin";

// POST /api/admin/assistant/prices/sync → { synced, data }. The response carries
// the refreshed rows; the hook applies them with setQueryData (invariant #6).
export function PriceSyncButton() {
  const sync = useSyncPrices();
  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
      {sync.isPending ? (
        <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
      ) : (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
      )}
      {sync.isPending ? "Syncing…" : "Sync prices from OpenRouter"}
    </button>
  );
}
