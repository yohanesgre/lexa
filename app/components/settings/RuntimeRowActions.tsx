import { RotateCcw, Settings, Trash2 } from "lucide-react";

export function RuntimeRowActions({ name, offline, onRestart, onEdit, onRemove }: { name: string; offline: boolean; onRestart: () => void; onEdit: () => void; onRemove: () => void }) {
  return (
    <>
      {offline && <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={onRestart} aria-label={`Restart ${name}`} title="Restart guide"><RotateCcw size={14} strokeWidth={1.5} /></button>}
      <button type="button" className="btn btn-ghost" style={{ width: 28, height: 28, padding: 0 }} onClick={onEdit} aria-label={`Edit ${name}`} title="Edit runtime"><Settings size={14} strokeWidth={1.5} /></button>
      <button type="button" className="btn btn-danger" style={{ width: 28, height: 28, padding: 0 }} onClick={onRemove} aria-label={`Remove ${name}`} title="Remove runtime"><Trash2 size={14} strokeWidth={1.5} /></button>
    </>
  );
}
