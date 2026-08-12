import { useState, useEffect } from "react";
import { Check, X, Trash2 } from "lucide-react";

interface ProjectSettingsModalProps {
  open: boolean;
  project: { id: string; name: string; description: string | null };
  pending: boolean;
  onClose: () => void;
  onSave: (input: { name: string; description: string }) => void;
  onDelete: () => void;
}

export function ProjectSettingsModal({ open, project, pending, onClose, onSave, onDelete }: ProjectSettingsModalProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setDeleteOpen(false);
  }, [open, project]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    onSave({
      name: name.trim(),
      description: description.trim(),
    });
  };

  const handleDelete = () => {
    if (pending) return;
    setDeleteOpen(false);
    onDelete();
  };

  const countsChip = "tasks, columns, and swimlanes";

  if (!open) return null;

  if (deleteOpen) {
    return (
      <>
        <button
          type="button"
          className="slideover-overlay"
          aria-label="Close dialog"
          onClick={() => setDeleteOpen(false)}
          />
        <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
          <dialog open
            className="dialog dialog-enter pointer-events-auto"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <h2 id="delete-project-title" className="font-display text-lg font-medium text-lx-text-primary">
              Delete &lsquo;{project.name}&rsquo;?
            </h2>
            <p className="text-sm text-lx-text-secondary mt-3 leading-5">
              This will permanently delete the project and all of its{" "}
              <span
                className="font-micro text-2xs"
                style={{
                  background: "var(--lx-surface-card)",
                  borderRadius: 4,
                  padding: "2px 5px",
                  color: "var(--lx-text-primary)",
                }}
              >
                {countsChip}
              </span>
              {" "}and wiki pages. This action cannot be undone.
            </p>
            <div className="flex items-center gap-2 mt-4 justify-end">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDeleteOpen(false)}
                disabled={pending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={handleDelete}
                disabled={pending}
              >
                <Trash2 size={14} strokeWidth={1.5} />
                Delete Project
              </button>
            </div>
          </dialog>
        </div>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="slideover-overlay"
        aria-label="Close dialog"
        onClick={onClose}
        />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog
          open
          className="modal dialog-enter pointer-events-auto"
          aria-labelledby="project-settings-title"
        >
          <form onSubmit={handleSave} style={{ display: "contents" }}>
          <div className="modal-header">
            <span id="project-settings-title" className="modal-title">Project Settings</span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 32, height: 32, padding: 0 }}
              aria-label="Close"
              onClick={onClose}
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
          <div className="modal-body">
            <div className="mb-4">
              <label className="field-label" htmlFor="project-settings-name">Name</label>
              <input
                id="project-settings-name"
                className="prop-input w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
              <div className="field-hint">Shown on the dashboard and in the nav. Slug is derived from the name.</div>
            </div>
            <div className="mb-4">
              <label className="field-label" htmlFor="project-settings-desc">Description</label>
              <textarea
                id="project-settings-desc"
                className="prop-input w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              style={{ marginRight: "auto" }}
              onClick={() => setDeleteOpen(true)}
              disabled={pending}
            >
              <Trash2 size={14} strokeWidth={1.5} />
              Delete Project
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || !name.trim()}
            >
              <Check size={14} strokeWidth={1.5} />
              Save Changes
            </button>
          </div>
          </form>
        </dialog>
      </div>
    </>
  );
}
