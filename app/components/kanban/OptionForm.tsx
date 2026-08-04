import { useEffect, useState, useEffectEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../ui/cn";
import type { FieldOption } from "../../../shared/types";

export interface OptionFormProps {
  kind: "priority" | "type";
  option?: FieldOption | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { label: string; color: string }) => void;
  zIndex?: number;
}

const swatches: { value: string; label: string }[] = [
  { value: "#FF4444", label: "Red" },
  { value: "#FF8844", label: "Orange" },
  { value: "#F0C040", label: "Amber" },
  { value: "#A3E635", label: "Lime" },
  { value: "#4ADE80", label: "Green" },
  { value: "#22D3EE", label: "Cyan" },
  { value: "#3B82F6", label: "Blue" },
  { value: "#A78BFA", label: "Violet" },
  { value: "#F472B6", label: "Pink" },
  { value: "#6B6560", label: "Gray" },
];

export function OptionForm({ kind, option, isOpen, onClose, onSubmit, zIndex = 80 }: OptionFormProps) {
  const isEdit = !!option;
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#F0C040");
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
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Label is required");
      return;
    }
    setError(null);
    onSubmit({ label: trimmed, color });
    onClose();
  };

  const title = kind === "priority" ? "Priority" : "Type";

  return createPortal(
    <>
      <button
        type="button"
        className="dialog-overlay"
        style={{ zIndex }}
        aria-label="Close dialog"
        onClick={onClose}
        />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: zIndex + 1 }}>
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 400, maxWidth: "calc(100vw - 48px)" }}
          aria-modal="true"
          aria-labelledby="option-form-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
              <h2 id="option-form-title" className="font-display text-base font-medium text-lx-text-primary">
                {isEdit ? `Edit ${title}` : `Add ${title}`}
              </h2>
              <button type="button" className="btn btn-ghost w-8 h-8 p-0" onClick={onClose} aria-label="Close">
                <X size={18} strokeWidth={1.5} />
              </button>
            </div>

            <div className="p-4">
              {error && (
                <div className="text-sm text-lx-text-danger mb-4 bg-lx-bg-danger-subtle rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="option-form-label">
                  Label
                </label>
                <input
                  id="option-form-label"
                  className="prop-input w-full"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={kind === "priority" ? "e.g. Blocker" : "e.g. Polish"}
                  autoFocus
                />
              </div>

              <div className="mb-2">
                <div className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Color
                </div>
                <div className="flex flex-wrap gap-2">
                  {swatches.map((c) => {
                    const selected = color.toUpperCase() === c.value.toUpperCase();
                    return (
                      <button
                        key={c.value}
                        type="button"
                        className={cn(
                          "w-7 h-7 rounded-md border border-lx-border-default",
                          selected && "ring-2 ring-lx-border-focus ring-offset-2 ring-offset-lx-surface-elevated"
                        )}
                        style={{ background: c.value }}
                        title={c.label}
                        onClick={() => setColor(c.value)}
                        aria-label={`Select ${c.label}`}
                        aria-pressed={selected}
                      />
                    );
                  })}
                </div>
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Renders as the badge/dot color on cards and in the property bar.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-lx-border-subtle">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                {isEdit ? "Save Changes" : `Add ${title}`}
              </button>
            </div>
          </form>
        </dialog>
      </div>
    </>,
    typeof document !== "undefined" ? document.body : null as any
  );
}
