import { describe, expect, it } from "vitest";
import { emptyFilters, isFilterActive, type FilterState } from "./filters";

describe("emptyFilters", () => {
  it("returns five empty sets", () => {
    const f = emptyFilters();
    expect(f.columns.size).toBe(0);
    expect(f.priorities.size).toBe(0);
    expect(f.types.size).toBe(0);
    expect(f.assignees.size).toBe(0);
    expect(f.swimlanes.size).toBe(0);
  });

  it("returns fresh sets on every call (no shared state)", () => {
    const a = emptyFilters();
    a.columns.add("c1");
    expect(emptyFilters().columns.size).toBe(0);
  });
});

describe("isFilterActive", () => {
  it("false for empty filters", () => {
    expect(isFilterActive(emptyFilters())).toBe(false);
  });

  it("true when any dimension is non-empty", () => {
    const partial: FilterState = { ...emptyFilters(), columns: new Set(["c1"]) };
    expect(isFilterActive(partial)).toBe(true);
    const priorities: FilterState = { ...emptyFilters(), priorities: new Set(["p1"]) };
    expect(isFilterActive(priorities)).toBe(true);
    const types: FilterState = { ...emptyFilters(), types: new Set(["t1"]) };
    expect(isFilterActive(types)).toBe(true);
    const assignees: FilterState = { ...emptyFilters(), assignees: new Set(["Maria"]) };
    expect(isFilterActive(assignees)).toBe(true);
    const swimlanes: FilterState = { ...emptyFilters(), swimlanes: new Set(["s1"]) };
    expect(isFilterActive(swimlanes)).toBe(true);
  });
});
