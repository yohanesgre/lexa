// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HearthTaskStatus } from "../../../shared/types";
import { FilterBar, HistoryStates, historyTotal, paginationLabel } from "./HearthControlPanel";

const SUMMARY: Record<HearthTaskStatus, number> = { queued: 1, running: 2, completed: 18, failed: 3, cancelled: 2 };

type HistoryResult = UseQueryResult<{ data: never[]; summary?: Record<HearthTaskStatus, number>; nextCursor?: string | null }, unknown>;

const EMPTY_HISTORY = { isLoading: false, isError: false } as unknown as HistoryResult;

describe("historyTotal", () => {
  it("sums the per-status summary into the run total", () => {
    expect(historyTotal(SUMMARY)).toBe(26);
  });

  it("returns null before the summary has loaded", () => {
    expect(historyTotal(undefined)).toBeNull();
  });
});

describe("paginationLabel", () => {
  it("shows the page size against the total (hearth-control-panel.html:304)", () => {
    expect(paginationLabel(5, 26)).toBe("Showing 5 of 26 runs");
  });

  it("falls back to the page size when no summary is available", () => {
    expect(paginationLabel(5, null)).toBe("Showing 5 runs");
  });

  it("labels the end-of-history page", () => {
    expect(paginationLabel(0, 26)).toBe("End of history");
  });
});

describe("HistoryStates empty state", () => {
  it("renders the flame glyph, not the previous path", () => {
    const { container } = render(
      <HistoryStates history={EMPTY_HISTORY} page={[]} filters={{ status: null, slug: "", skillId: "", teamId: "" }} cursor={null}>
        <div />
      </HistoryStates>
    );

    expect(screen.getByText("No Hearth runs yet")).toBeInTheDocument();
    const path = container.querySelector("svg path");
    expect(path?.getAttribute("d")).toContain("M8.5 14.5A2.5 2.5");
  });
});

describe("FilterBar team filter", () => {
  const noop = () => {};
  const projects = { data: [] };
  const skills = { data: [] };
  const teams = [
    { id: "t1", name: "Team One" },
    { id: "t2", name: "Team Two" },
  ];

  it("renders the team select for superadmins and reports changes", () => {
    const onReset = vi.fn();
    render(
      <FilterBar
        status={null}
        slug=""
        skillId=""
        teamId=""
        teams={teams}
        showTeamFilter
        projects={projects}
        skills={skills}
        onReset={onReset}
      />
    );
    const select = screen.getByLabelText("Filter by team");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "All teams" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "t2" } });
    expect(onReset).toHaveBeenCalledWith({ teamId: "t2" });
  });

  it("hides the team select when not permitted", () => {
    render(
      <FilterBar
        status={null}
        slug=""
        skillId=""
        teamId=""
        teams={teams}
        showTeamFilter={false}
        projects={projects}
        skills={skills}
        onReset={noop}
      />
    );
    expect(screen.queryByLabelText("Filter by team")).not.toBeInTheDocument();
  });
});
