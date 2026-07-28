import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "../ui/cn";
import type { Column } from "../../../shared/types";

export interface ColumnFormProps {
  slug: string;
  column?: Column | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    color?: string | null;
    wipLimit?: number | null;
    requiredFields?: string[];
    githubState?: string | null;
  }) => void;
}

const colors: { value: string | null; label: string; hex: string }[] = [
  { value: null, label: "None", hex: "transparent" },
  { value: "#22D3EE", label: "Cyan", hex: "#22D3EE" },
  { value: "#F0C040", label: "Amber", hex: "#F0C040" },
  { value: "#4ADE80", label: "Green", hex: "#4ADE80" },
  { value: "#FF4444", label: "Red", hex: "#FF4444" },
  { value: "#A855F7", label: "Purple", hex: "#A855F7" },
];

const requiredFieldOptions = [
  { value: "type", label: "Type" },
  { value: "assignee", label: "Assignee" },
  { value: "description", label: "Description" },
] as const;

type RequiredFieldValue = (typeof requiredFieldOptions)[number]["value"];

export function ColumnForm({ column, isOpen, onClose, onSubmit }: ColumnFormProps) {
  const isEdit = !!column;
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [wipLimit, setWipLimit] = useState("");
  const [requiredFields, setRequiredFields] = useState<RequiredFieldValue[]>([]);
  const [githubState, setGithubState] = useState<"open" | "closed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (column) {
      setName(column.name);
      setColor(column.color || null);
      setWipLimit(column.wipLimit === null ? "" : String(column.wipLimit));
      setRequiredFields(column.requiredFields as RequiredFieldValue[]);
      setGithubState(column.githubState);
    } else {
      setName("");
      setColor(null);
      setWipLimit("");
      setRequiredFields([]);
      setGithubState(null);
    }
    setError(null);
  }, [isOpen, column]);

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
    const parsedWip = wipLimit.trim() === "" ? null : Number(wipLimit);
    if (parsedWip !== null && (Number.isNaN(parsedWip) || parsedWip < 1)) {
      setError("WIP limit must be at least 1");
      return;
    }
    setError(null);
    onSubmit({
      name: trimmedName,
      color,
      wipLimit: parsedWip,
      requiredFields,
      githubState,
    });
    onClose();
  };

  const toggleRequiredField = (field: RequiredFieldValue) => {
    setRequiredFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
    );
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
          aria-labelledby="column-form-title"
        >
          <form onSubmit={handleSubmit}>
            <div className="flex items-center justify-between h-14 px-4 border-b border-lx-border-subtle flex-shrink-0">
              <h2 id="column-form-title" className="font-display text-base font-medium text-lx-text-primary">
                {isEdit ? "Edit Column" : "Create Column"}
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
                  placeholder="e.g. In Progress"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Color
                </label>
                <div className="flex flex-wrap gap-2">
                  {colors.map((c) => {
                    const selected = color === c.value;
                    return (
                      <button
                        key={c.label}
                        type="button"
                        className={cn(
                          "w-7 h-7 rounded-md border border-lx-border-default flex items-center justify-center",
                          selected && "ring-2 ring-lx-border-focus ring-offset-2 ring-offset-lx-surface-elevated"
                        )}
                        style={{ background: c.hex }}
                        title={c.label}
                        onClick={() => setColor(c.value)}
                        aria-label={`Select ${c.label}`}
                        aria-pressed={selected}
                      >
                        {c.value === null && (
                          <X size={12} className="text-lx-text-muted" strokeWidth={1.5} />
                        )}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Renders as the 3px strip at the top of the board column. &ldquo;None&rdquo; leaves it transparent.
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  WIP Limit
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <input
                  className="prop-input"
                  type="number"
                  min={1}
                  value={wipLimit}
                  onChange={(e) => setWipLimit(e.target.value)}
                  placeholder="—"
                  style={{ width: 96, textAlign: "right" }}
                />
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Empty = no limit. Enforced atomically when a card is moved into this column.
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Required Fields
                </label>
                <div className="space-y-1">
                  {requiredFieldOptions.map((field) => {
                    const checked = requiredFields.includes(field.value);
                    return (
                      <button
                        key={field.value}
                        type="button"
                        className="check-row w-full"
                        onClick={() => toggleRequiredField(field.value)}
                      >
                        <span className={cn("checkbox", checked && "checked")} />
                        <span className="text-sm text-lx-text-primary font-body">{field.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Enforced on task create, move into this column, and update.
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  GitHub State Mapping
                </label>
                <select
                  className="prop-input w-full"
                  value={githubState ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setGithubState(value === "" ? null : (value as "open" | "closed"));
                  }}
                >
                  <option value="">None</option>
                  <option value="open">open</option>
                  <option value="closed">closed</option>
                </select>
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Maps this column to a GitHub issue state for two-way sync.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-lx-border-subtle">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                <Plus size={14} strokeWidth={1.5} />
                {isEdit ? "Save Changes" : "Create Column"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
