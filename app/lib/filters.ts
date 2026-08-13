export interface FilterState {
  columns: Set<string>;
  priorities: Set<string>;
  types: Set<string>;
  assignees: Set<string>;
  swimlanes: Set<string>;
}

export const emptyFilters = (): FilterState => ({
  columns: new Set(),
  priorities: new Set(),
  types: new Set(),
  assignees: new Set(),
  swimlanes: new Set(),
});

export const isFilterActive = (filters: FilterState) =>
  filters.columns.size > 0 ||
  filters.priorities.size > 0 ||
  filters.types.size > 0 ||
  filters.assignees.size > 0 ||
  filters.swimlanes.size > 0;

// ?swimlane=<id> search-param parsing — drives the tasks page lane filter.
// Any non-string (missing, ?swimlane=, arrays) → "" (all lanes).
export function parseSwimlaneParam(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw : "";
}
