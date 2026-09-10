import type { Board, Swimlane, Task } from "../../../shared/types";
import { cn } from "../ui/cn";
import { BoardLane } from "./BoardLane";
import { SwimlaneHeader } from "./SwimlaneHeader";

// The board's lane/column grid (plus the no-columns empty state). Kept out
// of KanbanBoard so the drag/drop host owns only interaction state.

export interface BoardGridProps {
  slug: string;
  board: Board;
  columns: Board["columns"];
  rows: { lane: Swimlane }[];
  archivedLanes: Swimlane[];
  showArchived: boolean;
  localTasks: Task[];
  childrenByParent: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
  cardHidden: (task: Task) => boolean;
  cardDimmed: (task: Task) => boolean;
  columnTotalCount: (columnId: string) => number;
  columnDimmed: (columnId: string) => boolean;
  cellDropId: (columnId: string, laneId: string) => string;
  flashColumnId: string | null;
  collapsed: ReadonlySet<string>;
  toggleLane: (laneId: string) => void;
  onOpenCreateTask?: (columnId: string, swimlaneId?: string) => void;
  onSelectTask: (task: Task) => void;
  onDelete?: ((id: string) => void) | undefined;
  selectedTaskId: string | null;
  newTaskIds: Set<string>;
  shakeTaskId: string | null;
  archiveTask: { mutate: (input: { id: string }) => unknown };
  restoreTask: { mutate: (input: { id: string }) => unknown };
  collapsedParents: Set<string>;
  setCollapsedParents: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  onAddColumn: () => void;
}

export function BoardGrid(props: BoardGridProps) {
  const {
    slug, board, columns, rows, archivedLanes, showArchived, localTasks,
    childrenByParent, blockedBy, cardHidden, cardDimmed, columnTotalCount, columnDimmed,
    cellDropId, flashColumnId, collapsed, toggleLane, onOpenCreateTask, onSelectTask,
    onDelete, selectedTaskId, newTaskIds, shakeTaskId, archiveTask, restoreTask,
    collapsedParents, setCollapsedParents, onAddColumn,
  } = props;

  return (
    <div className={cn("board-scroll", columns.length === 0 && "items-center justify-center")}>
      {columns.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div className="empty-state-icon">
            <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16M15 4v16" />
            </svg>
          </div>
          <div className="empty-state-title">No columns yet</div>
          <div className="empty-state-desc">Add a column to start tracking tasks.</div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 16 }}
            onClick={onAddColumn}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M12 5v14m-7-7h14" />
            </svg>
            Add Column
          </button>
        </div>
      ) : (
        rows.map(({ lane }) => (
          <BoardLane
            key={lane.id}
            slug={slug}
            lane={lane}
            columns={columns}
            board={board}
            localTasks={localTasks}
            childrenByParent={childrenByParent}
            blockedBy={blockedBy}
            cardHidden={cardHidden}
            cardDimmed={cardDimmed}
            columnTotalCount={columnTotalCount}
            columnDimmed={columnDimmed}
            cellDropId={cellDropId}
            flashColumnId={flashColumnId}
            collapsed={collapsed}
            toggleLane={toggleLane}
            onOpenCreateTask={onOpenCreateTask}
            onSelectTask={onSelectTask}
            onDelete={onDelete}
            selectedTaskId={selectedTaskId}
            newTaskIds={newTaskIds}
            shakeTaskId={shakeTaskId}
            archiveTask={archiveTask}
            restoreTask={restoreTask}
            collapsedParents={collapsedParents}
            setCollapsedParents={setCollapsedParents}
          />
        ))
      )}
      {showArchived && archivedLanes.length > 0 && (
        <div style={{ margin: "16px 0", maxWidth: 640 }}>
          {archivedLanes.map((lane) => (
            <SwimlaneHeader
              key={lane.id}
              slug={slug}
              lane={lane}
              count={localTasks.filter((t) => t.swimlaneId === lane.id).length}
            />
          ))}
        </div>
      )}
    </div>
  );
}