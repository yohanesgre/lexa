import { useEffect, useState, useEffectEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";
import type { Swimlane } from "../../../shared/types";
import { DatePicker } from "../ui/DatePicker";
import { useMilestones } from "../../lib/queries";

export interface SwimlaneFormProps {
  slug: string;
  swimlane?: Swimlane | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string | null | undefined; dueAt?: string | null | undefined; startAt?: string | null | undefined; milestoneId?: string | null }) => void;
  zIndex?: number | undefined;
}

export function SwimlaneForm({ slug, swimlane, isOpen, onClose, onSubmit, zIndex = 70 }: SwimlaneFormProps) {
  const isEdit = !!swimlane;
  const { data: milestones = [] } = useMilestones(slug);

  interface FormState {
    name: string;
    description: string;
    dueAt: string | null;
    startAt: string | null;
    milestoneId: string | null;
  }
  const [state, setState] = useState<FormState>({
    name: "",
    description: "",
    dueAt: null,
    startAt: null,
    milestoneId: null,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<FormState> | ((s: FormState) => FormState)) =>
    setState((s) => (typeof patch === "function" ? patch(s) : { ...s, ...patch }));

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
  // prevKey starts as isOpen:false so the first open render always seeds
  // (the old useEffect ran on mount); the render-time adjust handles
  // close→reopen with a different swimlane.
  const [prevKey, setPrevKey] = useState<{ swimlane: Swimlane | null | undefined; isOpen: boolean }>({ swimlane: undefined, isOpen: false });
  if (prevKey.swimlane !== swimlane || prevKey.isOpen !== isOpen) {
    setPrevKey({ swimlane, isOpen });
    if (isOpen) {
      setState({
        name: swimlane?.name ?? "",
        description: swimlane?.description ?? "",
        dueAt: swimlane?.dueAt ?? null,
        startAt: swimlane?.startAt ?? null,
        milestoneId: swimlane?.milestoneId ?? null,
      });
      setError(null);
    }
  }

  if (!isOpen) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = state.name.trim();
    if (trimmedName === "") {
      setError("Name is required");
      return;
    }
    if (state.startAt && state.dueAt && state.startAt > state.dueAt) {
      setError("Start date must be before the due date");
      return;
    }
    setError(null);
    const trimmedDescription = state.description.trim();
    onSubmit({
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      dueAt: state.dueAt,
      startAt: state.startAt,
      milestoneId: state.milestoneId,
    });
    onClose();
  };

  const isBacklog = isEdit && swimlane?.kind === "backlog";

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
                  value={state.name}
                  onChange={(e) => set({ name: e.target.value })}
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
                  value={state.description}
                  onChange={(e) => set({ description: e.target.value })}
                  placeholder="e.g. Release track, team, or sprint goal"
                  rows={4}
                />
                <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                  Shown as a subtitle under the swimlane header on the board.
                </p>
              </div>

              {!isBacklog && (
                <div className="mb-4">
                  <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="swimlane-milestone">
                    Milestone
                    <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                      Optional
                    </span>
                  </label>
                  <select
                    id="swimlane-milestone"
                    className="prop-input w-full"
                    value={state.milestoneId ?? ""}
                    onChange={(e) => set({ milestoneId: e.target.value === "" ? null : e.target.value })}
                  >
                    <option value="">None — loose sprint</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}{m.archivedAt ? " (archived)" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                    Stored as swimlanes.milestone_id. &ldquo;None&rdquo; = loose sprint (no milestone).
                  </p>
                </div>
              )}

              {!isBacklog && (
                <div className="mb-4">
                  <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="swimlane-start">
                    Start date
                    <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                      Optional
                    </span>
                  </label>
                  <DatePicker value={state.startAt} onChange={(v) => set({ startAt: v })} className="w-full" />
                  <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                    Stored as swimlanes.start_at YYYY-MM-DD. Validated start &le; due on save.
                  </p>
                </div>
              )}

              {!isBacklog && (
                <div className="mb-4">
                  <label className="block text-xs font-medium text-lx-text-secondary mb-1.5 font-body" htmlFor="swimlane-due">
                    Due date
                    <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-lx-text-muted ml-1.5">
                      Optional
                    </span>
                  </label>
                  <DatePicker value={state.dueAt} onChange={(v) => set({ dueAt: v })} className="w-full" />
                  <p className="text-[11px] leading-4 text-lx-text-muted mt-1 font-body">
                    Stored as swimlanes.due_at YYYY-MM-DD — date-only, no time-of-day. Empty = lane has no deadline.
                  </p>
                </div>
              )}
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
