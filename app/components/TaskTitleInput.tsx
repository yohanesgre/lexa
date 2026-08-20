import { useToast } from "./ui/Toast";

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
  taskKey: string;
}

export function TaskTitleInput(props: TaskTitleInputProps) {
  const { isArchived, isCreate, createTitle, setCreateTitle, onCreate, onClose, editingTitle, draft, setDraft, onSaveTitle, setEditingTitle, taskTitle, taskKey } = props;
  const toast = useToast();
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(taskKey);
      toast.push("success", "Key copied", taskKey);
    } catch {
      toast.push("error", "Failed to copy key");
    }
  };
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
  <div
    className="slideover-title"
    style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", border: "none", background: "none", padding: 0, textAlign: "left" }}
  >
    <button
      type="button"
      className="slideover-title-text"
      style={{ border: "none", background: "none", padding: 0, textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer" }}
      title="Click to edit"
      onClick={() => {
        setDraft(taskTitle);
        setEditingTitle(true);
      }}
    >
      {taskKey && <span className="task-key">{taskKey}</span>}
      <span>{taskTitle}</span>
    </button>
    <button
      type="button"
      className="icon-btn"
      title="Copy key"
      aria-label="Copy key"
      onClick={copyKey}
    >
      ⧉
    </button>
  </div>
)}
  </>
  );
}