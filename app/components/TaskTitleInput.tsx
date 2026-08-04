import { ArchiveIcon } from "./icons";

interface TaskTitleInputProps {
  isArchived: boolean;
  isCreate: boolean;
  createTitle: string;
  setCreateTitle: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
  editingTitle: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onSaveTitle: () => void;
  setEditingTitle: (v: boolean) => void;
  taskTitle: string;
}

export function TaskTitleInput(props: TaskTitleInputProps) {
  const { isArchived, isCreate, createTitle, setCreateTitle, onCreate, onClose, editingTitle, draft, setDraft, onSaveTitle, setEditingTitle, taskTitle } = props;
  return (
  <>
{isCreate ? (
  <input
    className="slideover-title-input"
    aria-label="Task title"
    placeholder="Task title..."
    value={createTitle}
    autoFocus
    onChange={(e) => setCreateTitle(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") onCreate();
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }}
  />
) : editingTitle ? (
  <input
    className="slideover-title-input"
    aria-label="Task title"
    value={draft}
    autoFocus
    onChange={(e) => setDraft(e.target.value)}
    onBlur={onSaveTitle}
    onKeyDown={(e) => {
      if (e.key === "Enter") onSaveTitle();
      if (e.key === "Escape") {
        setDraft(taskTitle);
        setEditingTitle(false);
        e.stopPropagation();
      }
    }}
  />
) : (
  <button
    type="button"
    className="slideover-title"
    style={{ border: "none", background: "none", padding: 0, textAlign: "left", cursor: "pointer" }}
    onClick={() => {
      setDraft(taskTitle);
      setEditingTitle(true);
    }}
    title="Click to edit"
  >
    {taskTitle}
  </button>
)}
  </>
  );
}
