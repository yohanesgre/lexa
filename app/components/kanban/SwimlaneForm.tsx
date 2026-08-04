import { useEffect, useState, useEffectEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";
import type { Swimlane } from "../../../shared/types";

export interface SwimlaneFormProps {
  slug: string;
  swimlane?: Swimlane | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string | null }) => void;
  zIndex?: number;
}

export function SwimlaneForm({ swimlane, isOpen, onClose, onSubmit, zIndex = 70 }: SwimlaneFormProps) {
  const isEdit = !!swimlane;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
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

  return createPortal(
    <>
      <button type="button" className="dialog-overlay" style={{ zIndex: zIndex }} aria-label="Close" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: zIndex + 1 }}>
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
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
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="swimlane-name">
                  Name
                </label>
                <input
                  id="swimlane-name"
                  className="prop-input w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sprint 8 — The Hollow Crown"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="swimlane-description">
                  Description
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <textarea
                  id="swimlane-description"
                  className="prop-input w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Release track, team, or sprint goal"
                  rows={4}
                />
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Shown as a subtitle under the swimlane header on the board.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 px-4 py-3 border-t border-lx-border-subtle">
              {isEdit && (
                <button
                  type="button"
                  className="btn btn-danger-solid"
                  style={{ marginRight: "auto" }}
                  onClick={() => {
                    if (window.confirm(`Delete "${swimlane!.name}"? This will unassign all tasks in this swimlane.`)) {
                      onClose();
                    }
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  Delete Swimlane
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                <Plus size={14} strokeWidth={1.5} />
                {isEdit ? "Save Changes" : "Create Swimlane"}
              </button>
            </div>
          </form>
        </dialog>
      </div>
    </>,
    typeof document !== "undefined" ? document.body : null as any
  );
}
