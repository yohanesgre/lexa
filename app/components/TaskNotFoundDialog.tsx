import { X } from "lucide-react";
import { cn } from "./ui/cn";

export function TaskNotFoundDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
<button type="button" className={cn("slideover-overlay", !open && "overlay-closed")} onClick={onClose} aria-label="Close" />
<dialog open className={cn("slideover", !open && "slideover-closed")} aria-modal="true" aria-label="Task details">
  <div className="slideover-header border-b border-lx-border-subtle">
    <span className="text-xs font-body text-lx-text-muted">Board</span>
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button type="button" className="btn btn-ghost !w-8 !h-8 !p-0" onClick={onClose} aria-label="Close">
        <X size={18} strokeWidth={1.5} />
      </button>
    </div>
  </div>
  <div className="slideover-body flex items-center justify-center" style={{ flexDirection: "column", gap: 12 }}>
    <div className="empty-state-icon">
      <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    </div>
    <div className="empty-state-title">Task not found</div>
    <div className="empty-state-desc">This task was deleted or the link is stale.</div>
    <button type="button" className="btn btn-primary" style={{ marginTop: 8 }} onClick={onClose}>
      Close
    </button>
  </div>
</dialog>
    </>
  );
}
