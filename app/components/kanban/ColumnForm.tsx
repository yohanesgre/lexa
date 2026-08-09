import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  zIndex?: number;
}

const colors: { value: string | null; label: string; hex: string }[] = [
  { value: null, label: "None", hex: "transparent" },
  { value: "#71717a", label: "Zinc", hex: "#71717a" },
  { value: "#ef4444", label: "Red", hex: "#ef4444" },
  { value: "#f97316", label: "Orange", hex: "#f97316" },
  { value: "#f59e0b", label: "Amber", hex: "#f59e0b" },
  { value: "#a3e635", label: "Lime", hex: "#a3e635" },
  { value: "#22c55e", label: "Green", hex: "#22c55e" },
  { value: "#10b981", label: "Emerald", hex: "#10b981" },
  { value: "#06b6d4", label: "Cyan", hex: "#06b6d4" },
  { value: "#3b82f6", label: "Blue", hex: "#3b82f6" },
  { value: "#6366f1", label: "Indigo", hex: "#6366f1" },
  { value: "#a78bfa", label: "Violet", hex: "#a78bfa" },
  { value: "#ec4899", label: "Pink", hex: "#ec4899" },
];

const requiredFieldOptions = [
  { value: "title", label: "Title" },
  { value: "assignee", label: "Assignee" },
  { value: "description", label: "Description" },
] as const;

type RequiredFieldValue = (typeof requiredFieldOptions)[number]["value"];

export function ColumnForm({ column, isOpen, onClose, onSubmit, zIndex = 70 }: ColumnFormProps) {
  const isEdit = !!column;
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [wipLimit, setWipLimit] = useState("");
  const [requiredFields, setRequiredFields] = useState<RequiredFieldValue[]>([]);
  const [githubState, setGithubState] = useState<"open" | "closed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Re-sync fields when opening — the form stays mounted between opens, so
  // state must be seeded from the target entity each time (create = empty).
  useEffect(() => {
    if (!isOpen) return;
    setName(column?.name ?? "");
    setColor(column?.color ?? null);
    setWipLimit(column?.wipLimit != null ? String(column.wipLimit) : "");
    setRequiredFields(
      (column?.requiredFields ?? []).filter(
        (f): f is RequiredFieldValue => requiredFieldOptions.some((o) => o.value === f)
      )
    );
    setGithubState(column?.githubState ?? null);
    setError(null);
  }, [isOpen, column]);

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

  return createPortal(
    <>
      <button
        type="button"
        className="dialog-overlay"
        style={{ zIndex: zIndex }}
        aria-label="Close dialog"
        onClick={onClose}
        />
      <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: zIndex + 1 }}>
        <dialog open
          className="dialog dialog-enter pointer-events-auto p-0"
          style={{ width: 440, maxWidth: "calc(100vw - 48px)" }}
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
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="column-form-name">
                  Name
                </label>
                <input
                  id="column-form-name"
                  className="prop-input w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. In Progress"
                  autoFocus
                />
              </div>

              <div className="mb-4">
                <div className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Color
                </div>
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
                <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="column-form-wip">
                  WIP Limit
                  <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                    Optional
                  </span>
                </label>
                <input
                  id="column-form-wip"
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
                <div className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  Required Fields
                </div>
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
                <div className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body">
                  GitHub State Mapping
                </div>
                <select
                  className="prop-input w-full"
                  aria-label="GitHub state mapping"
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
                  Maps this column to a GitHub issue state for two-way sync. Uses{" "}
                  <span className="font-mono">columns.github_state</span> — renaming the column never breaks sync.
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
        </dialog>
      </div>
    </>,
    typeof document !== "undefined" ? document.body : null as any
  );
}
