import { FolderInput, Pencil, Plus, Trash2 } from "lucide-react";

interface WikiPageContextMenuProps {
  x: number;
  y: number;
  onAddChild: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export function WikiPageContextMenu({ x, y, onAddChild, onRename, onDelete }: WikiPageContextMenuProps) {
  return (
    <div
      id="wiki-page-context-menu"
      className="menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button type="button" className="menu-item" onClick={onAddChild} role="menuitem">
        <Plus size={14} strokeWidth={1.5} />
        Add child page
      </button>
      <button type="button" className="menu-item" onClick={onRename} role="menuitem">
        <Pencil size={14} strokeWidth={1.5} />
        Rename
      </button>
      <button type="button" className="menu-item" disabled role="menuitem" aria-disabled="true">
        <FolderInput size={14} strokeWidth={1.5} />
        Move
      </button>
      <div className="menu-separator" />
      <button type="button" className="menu-item danger" onClick={onDelete} role="menuitem">
        <Trash2 size={14} strokeWidth={1.5} />
        Delete
      </button>
    </div>
  );
}
