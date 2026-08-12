import { useState } from "react";
import { Plus, X } from "lucide-react";

interface CreateProjectModalProps {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string }) => void;
}

export function CreateProjectModal({ open, pending, onClose, onSubmit }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  if (!open) return null;

  const handleCreate = () => {
    onSubmit({
      name: name.trim(),
      description: desc.trim() || undefined,
    });
    setName("");
    setDesc("");
  };

  return (
    <>
      <button type="button" className="slideover-overlay" aria-label="Close dialog" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
        <dialog open
          className="modal dialog-enter pointer-events-auto"
          aria-modal="true"
          aria-labelledby="create-project-title"
          style={{ maxWidth: 440 }}
        >
          <div className="modal-header">
            <span id="create-project-title" className="modal-title">New Project</span>
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
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="field-label" htmlFor="create-project-name">Name</label>
              <input
                id="create-project-name"
                className="prop-input w-full"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder=""
                disabled={pending}
              />
              <div className="field-hint">Shown on the dashboard and in the nav. Slug is derived from the name.</div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="create-project-desc">Description</label>
              <textarea
                id="create-project-desc"
                className="prop-input w-full"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
                disabled={pending}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={pending || !name.trim()} onClick={handleCreate}>
              <Plus size={14} strokeWidth={1.5} />
              Create Project
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
