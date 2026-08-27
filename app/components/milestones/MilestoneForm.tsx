import { useEffect, useState, useEffectEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import type { Milestone } from "../../../shared/types";
import { DatePicker } from "../ui/DatePicker";

export interface MilestoneFormProps {
  slug: string;
  milestone?: Milestone | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string | null | undefined; dueAt?: string | null }) => void;
  zIndex?: number | undefined;
}

export function MilestoneForm({ milestone, isOpen, onClose, onSubmit, zIndex = 70 }: MilestoneFormProps) {
  const isEdit = !!milestone;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  });
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      onEscape(event);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Seed fields when the form opens — it stays mounted between opens, so
  // state is re-seeded from the target entity each time (create = empty).
  // Adjusted during render (not in an effect) so a stale close→reopen with a
  // different milestone never carries over previous values.
  const [prevKey, setPrevKey] = useState<{ milestone: Milestone | null | undefined; isOpen: boolean }>({ milestone, isOpen });
  if (prevKey.milestone !== milestone || prevKey.isOpen !== isOpen) {
    setPrevKey({ milestone, isOpen });
    if (isOpen) {
      setName(milestone?.name ?? "");
      setDescription(milestone?.description ?? "");
      setDueAt(milestone?.dueAt ?? null);
      setError(null);
    }
  }

  if (!isOpen) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setError("Name is required");
      return;
    }
    setError(null);
    const trimmedDescription = description.trim();
    onSubmit({
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      dueAt,
    });
    onClose();
  };

  return createPortal(
    <>
      <button type="button" className="dialog-overlay" style={{ zIndex: zIndex }} aria-label="Close" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: zIndex + 1 }}>
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="milestone-form-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
              <h2 id="milestone-form-title" className="font-display text-base font-medium text-lx-text-primary">
                {isEdit ? "Edit Milestone" : "Create Milestone"}
              </h2>
              <button
                type="button"
                className="btn btn-ghost w-8 h-8 p-0"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>

            <div className="p-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 140px)" }}>
              {error && (
                <div className="text-sm text-lx-text-danger mb-4 bg-lx-bg-danger-subtle rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="milestone-name">
                  Name
                </label>
                <input
                  id="milestone-name"
                  className="prop-input w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. v1.0 launch"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="milestone-description">
                  Description
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <textarea
                  id="milestone-description"
                  className="prop-input w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  style={{ resize: "vertical", minHeight: 80 }}
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="milestone-due">
                  Due date
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <DatePicker value={dueAt} onChange={setDueAt} className="w-full" />
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Stored as milestones.due_at YYYY-MM-DD. Empty = no deadline; the milestone lands in the timeline UNSET DATES section.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-lx-border-subtle">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                <Plus size={14} strokeWidth={1.5} />
                {isEdit ? "Save Changes" : "Create Milestone"}
              </button>
            </div>
          </form>
        </dialog>
      </div>
    </>,
    typeof document !== "undefined" ? document.body : null as any
  );
}
