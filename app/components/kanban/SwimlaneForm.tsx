import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Swimlane } from "../../../shared/types";

export interface SwimlaneFormProps {
  slug: string;
  swimlane?: Swimlane | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string | null }) => void;
}

export function SwimlaneForm({ swimlane, isOpen, onClose, onSubmit }: SwimlaneFormProps) {
  const isEdit = !!swimlane;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (swimlane) {
      setName(swimlane.name);
      setDescription(swimlane.description);
    } else {
      setName("");
      setDescription("");
    }
    setError(null);
  }, [isOpen, swimlane]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

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
    });
    onClose();
  };

  return (
    <>
      <div className="dialog-overlay" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none">
        <div
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="swimlane-form-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
              <h2 id="swimlane-form-title" className="font-display text-base font-medium text-lx-text-primary">
                {isEdit ? "Edit Swimlane" : "Create Swimlane"}
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
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Name
                </label>
                <input
                  className="prop-input w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sprint 8 — The Hollow Crown"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Description
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <textarea
                  className="prop-input w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Release track, team, or sprint goal"
                  rows={3}
                />
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Shown as a subtitle under the swimlane header on the board.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-lx-border-subtle">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                <Plus size={14} strokeWidth={1.5} />
                {isEdit ? "Save Changes" : "Create Swimlane"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
