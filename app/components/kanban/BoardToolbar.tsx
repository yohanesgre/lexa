import { cn } from "../ui/cn";
import { FilterButton, ActiveFilterBar } from "./BoardFilters";
import { isFilterActive, type FilterState } from "../../lib/filters";
import type { Board } from "../../../shared/types";

export function BoardToolbar({ board, showArchived, filters, onToggleArchived, onFiltersChange, onOpenSettings }: {
  board: Board;
  showArchived: boolean;
  filters: FilterState;
  onToggleArchived: (v: boolean) => void;
  onFiltersChange: (f: FilterState) => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <div className="board-header">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold text-lx-text-primary">{board.project.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={cn("btn btn-ghost text-sm", showArchived && "active")}
            onClick={() => onToggleArchived(!showArchived)}
            title="Show archived tasks"
          >
            <span className={cn("toggle-switch", showArchived && "is-on")} />
            Show archived
          </button>
          <FilterButton board={board} filters={filters} onChange={onFiltersChange} />
          <button
            type="button"
            className="btn btn-ghost text-sm"
            onClick={onOpenSettings}
          >
            Settings
          </button>
        </div>
      </div>
      {isFilterActive(filters) && <ActiveFilterBar board={board} filters={filters} onChange={onFiltersChange} />}
    </>
  );
}
