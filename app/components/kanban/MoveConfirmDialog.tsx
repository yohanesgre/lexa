import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "../ui/cn";
import { formatDueLabel, parseDateOnly } from "../../lib/dates";
import type { Board, Task } from "../../../shared/types";
import type { MoveTarget } from "./KanbanBoard";

export interface PendingMove {
  task: Task;
  target: MoveTarget;
}

interface MoveConfirmDialogProps {
  board: Board;
  pending: PendingMove | null;
  resolve: (clearDueAt: boolean) => void;
  cancel: () => void;
}

function overdueDays(dueAt: string): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - parseDateOnly(dueAt).getTime()) / 86400000);
}

export function MoveConfirmDialog({ board, pending, resolve, cancel }: MoveConfirmDialogProps) {
  const [checked, setChecked] = useState(false);
  if (!pending) return null;

  const lane = board.swimlanes.find((l) => l.id === pending.target.swimlaneId);
  if (!lane) return null;

  const laneDue = lane.dueAt ? formatDueLabel(lane.dueAt) : null;
  const taskDue = pending.task.dueAt ? formatDueLabel(pending.task.dueAt) : null;
  const laneOverdue = !!laneDue?.overdue;
  const conflict = !!taskDue && !!laneDue && pending.task.dueAt! > lane.dueAt!;

  return (
    <>
      <button
        type="button"
        className="dialog-overlay"
        style={{ zIndex: 80 }}
        aria-label="Close"
        onClick={cancel}
      />
      <div className="fixed inset-0 flex items-center justify-center z-[81] pointer-events-none">
        <dialog open className="modal dialog-enter pointer-events-auto" aria-modal="true" aria-label="Confirm move">
          <div className="modal-header">
            <span className="modal-title">{laneOverdue ? "Overdue lane" : "Deadline conflict"}</span>
            <button type="button" className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }} onClick={cancel} aria-label="Close">
              <X size={18} strokeWidth={1.5} />
            </button>
          </div>
          <div className="modal-body">
            <p className="text-sm text-lx-text-secondary" style={{ lineHeight: 1.5 }}>
              {laneOverdue ? (
                <>
                  Lane <span className="font-mono">{lane.name}</span> is overdue ({overdueDays(lane.dueAt!)}d). Move anyway?
                </>
              ) : (
                <>
                  Card due <span className="font-mono">{taskDue?.text}</span> is later than lane due <span className="font-mono">{laneDue?.text}</span>.
                </>
              )}
            </p>
            {conflict && (
              <label
                className="check-row"
                style={{ cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  className="checkbox-input"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span className={cn("checkbox", checked && "checked")} />
                Clear card deadline ({taskDue?.text} → none)
              </label>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => resolve(conflict && checked)}>
              {laneOverdue ? "Move" : "Move anyway"}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
