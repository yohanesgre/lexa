import { ArchiveIcon, TrashIcon } from "./icons";

interface TaskFooterProps {
  isCreate: boolean;
  isArchived: boolean;
  creating: boolean;
  createTitle: string;
  createColumnId: string;
  onClose: () => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDeleteClick: () => void;
  taskId: string;
}

export function TaskFooter({ isCreate, isArchived, creating, createTitle, createColumnId, onClose, onCreate, onArchive, onRestore, onDeleteClick, taskId }: TaskFooterProps) {
  const handleClose = onClose;
  const handleCreate = onCreate;
  return (
<div className="slideover-footer">
  {isCreate ? (
    <>
      <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Unsaved draft</span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-ghost" onClick={handleClose}>
          Cancel
        </button>
        <button type="button"
          className="btn btn-primary"
          onClick={handleCreate}
          disabled={!createTitle.trim() || !createColumnId || creating}
        >
          {creating ? "Creating..." : "Create task"}
        </button>
      </div>
    </>
  ) : (
    <>
      {isArchived ? (
        <button type="button" className="btn btn-ghost" onClick={() => onRestore(taskId)} title="Restore this task to the board">
          <ArchiveIcon size={14} />
          Restore
        </button>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => onArchive(taskId)} title="Archive this task">
          <ArchiveIcon size={14} />
          Archive
        </button>
      )}
      <button
        type="button"
        className="btn btn-danger"
        onClick={onDeleteClick}
      >
        <TrashIcon size={14} />
        Delete
      </button>
    </>
  )}
</div>
  );
}
