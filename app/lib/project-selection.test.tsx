// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectSelectionProvider, useProjectSelection } from "./project-selection";
import type { Project } from "../../shared/types";

const fetchMock = vi.fn();

// The router is not part of this unit — the provider only reads params.slug
// and the pathname (to skip public pages). Tests run on private paths.
let routeSlug: string | undefined;
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: routeSlug }),
  useRouterState: (opts?: { select?: (s: { location: { pathname: string } }) => unknown }) =>
    opts?.select
      ? opts.select({ location: { pathname: "/demo" } })
      : { location: { pathname: "/demo" } },
}));

const PROJECTS: Project[] = [
  { id: "p1", slug: "alpha", key: "EG", name: "Alpha", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  { id: "p2", slug: "beta", key: "EG", name: "Beta", description: "", repos: [], createdAt: "t", updatedAt: "t" },
];

function Probe() {
  const { selectedSlug, selectedProjectName, setSelectedSlug } = useProjectSelection();
  return (
    <div>
      <span data-testid="slug">{selectedSlug ?? ""}</span>
      <span data-testid="name">{selectedProjectName ?? ""}</span>
      <button onClick={() => setSelectedSlug("beta")}>pick beta</button>
    </div>
  );
}

let queryClient: QueryClient;

function renderProvider() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectSelectionProvider>
        <Probe />
      </ProjectSelectionProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  routeSlug = undefined;
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: PROJECTS, nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("ProjectSelectionProvider", () => {
  it("falls back to the first project when nothing is stored", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("slug").textContent).toBe("alpha"));
    expect(screen.getByTestId("name").textContent).toBe("Alpha");
  });
  it("prefers the stored selection once projects load", async () => {
    localStorage.setItem("lexa:selectedProject", "beta");
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("slug").textContent).toBe("beta"));
    expect(screen.getByTestId("name").textContent).toBe("Beta");
  });
});
