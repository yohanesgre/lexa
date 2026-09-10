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
  slug: string | undefined;
}

export function TaskTitleInput(props: TaskTitleInputProps) {
  const { isArchived, isCreate, createTitle, setCreateTitle, onCreate, onClose, editingTitle, draft, setDraft, onSaveTitle, setEditingTitle, taskTitle, taskKey, slug } = props;
  const toast = useToast();
  const copyLink = async () => {
    const path = slug ? `/${slug}/tasks/${taskKey}` : `/tasks/${taskKey}`;
    const url = `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.push("success", "Link copied", url);
    } catch {
      toast.push("error", "Failed to copy link");
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
      style={{ border: "none", background: "none", padding: 0, textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}
      title="Click to edit"
      onClick={() => {
        setDraft(taskTitle);
        setEditingTitle(true);
      }}
    >
      {taskKey && <span className="task-key" style={{ flexShrink: 0 }}>{taskKey}</span>}
      <span style={{ minWidth: 0 }}>{taskTitle}</span>
    </button>
    <button
      type="button"
      className="icon-btn"
      title="Copy link"
      aria-label="Copy link"
      onClick={copyLink}
    >
      ⧉
    </button>
  </div>
)}
  </>
  );
}
