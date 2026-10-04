// @vitest-environment jsdom
// Invariant #6: the PATCH response is authoritative — useUpdateTeam seeds the
// ["teams"] list from it and never invalidates on the mutation path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor, screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { createFetchMock, createQueryWrapper, createTestQueryClient } from "../../test-utils";
import { useUpdateTeam } from "./team";
import type { Team } from "../../../shared/types";

const { fetchMock, routes, mockFetch } = createFetchMock();

const TEAM: Team = { id: "t1", name: "Emberfall", slug: "emberfall", createdAt: "t" };
const OTHER: Team = { id: "t2", name: "Other", slug: "other", createdAt: "t" };

let queryClient: QueryClient;
let wrapper: ReturnType<typeof createQueryWrapper>;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  queryClient = createTestQueryClient();
  wrapper = createQueryWrapper(queryClient, { toast: true });
  queryClient.setQueryData<Team[]>(["teams"], [TEAM, OTHER]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("useUpdateTeam", () => {
  it("seeds the teams cache from the PATCH response — no invalidation", async () => {
    routes.set("PATCH /api/teams/t1", { ...TEAM, name: "Renamed" });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateTeam(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ teamId: "t1", name: "Renamed" }); });

    const teams = queryClient.getQueryData<Team[]>(["teams"])!;
    expect(teams.find((t) => t.id === "t1")?.name).toBe("Renamed");
    expect(teams.find((t) => t.id === "t2")?.name).toBe("Other");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("toasts an error when the PATCH fails", async () => {
    const { result } = renderHook(() => useUpdateTeam(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ teamId: "t1", name: "Renamed" }).catch(() => {}); });
    await waitFor(() => expect(screen.getByText("Failed to update team")).toBeTruthy());
  });
});
