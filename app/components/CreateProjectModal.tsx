import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useTeams } from "../lib/queries";
import { Field } from "./ui/Field";
import { TextInput } from "./ui/TextInput";
import { TextArea } from "./ui/TextArea";
import { SelectInput } from "./ui/SelectInput";

interface CreateProjectModalProps {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description?: string; teamId: string | null }) => void;
}

export function CreateProjectModal({ open, pending, onClose, onSubmit }: CreateProjectModalProps) {
  const { data: teams = [], isLoading: teamsLoading } = useTeams();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [teamId, setTeamId] = useState<string>("");

  if (!open) return null;

  const handleCreate = () => {
    onSubmit({
      name: name.trim(),
      description: desc.trim() || undefined,
      teamId: teamId || null,
    });
    setName("");
    setDesc("");
    setTeamId("");
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
            <Field label="Name" htmlFor="create-project-name" hint="Shown on the dashboard and in the nav. Slug is derived from the name." className="field">
              <TextInput id="create-project-name" value={name} onChange={setName} autoFocus disabled={pending} />
            </Field>

            <Field label="Team" htmlFor="create-project-team" hint="The owning team scopes who can see and use the project. Unassigned (no team) is superadmin-only." className="field">
              <SelectInput id="create-project-team" value={teamId} onChange={setTeamId} disabled={pending || teamsLoading} aria-label="Project team" className="w-full">
                <option value="">Select a team…</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.slug})</option>
                ))}
              </SelectInput>
            </Field>

            <Field label="Description" htmlFor="create-project-desc" className="field">
              <TextArea id="create-project-desc" value={desc} onChange={setDesc} rows={3} disabled={pending} />
            </Field>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || !name.trim() || !teamId}
              onClick={handleCreate}
            >
              <Plus size={14} strokeWidth={1.5} />
              Create Project
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
