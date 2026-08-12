// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectSelectionProvider, useProjectSelection } from "./project-selection";
import type { Project } from "../../shared/types";

const fetchMock = vi.fn();

// The router is not part of this unit — the provider only reads params.slug.
let routeSlug: string | undefined;
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ slug: routeSlug }),
}));

const PROJECTS: Project[] = [
  { id: "p1", slug: "alpha", name: "Alpha", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  { id: "p2", slug: "beta", name: "Beta", description: "", repos: [], createdAt: "t", updatedAt: "t" },
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

  it("drops a stored slug that no longer exists and falls back to the first project", async () => {
    localStorage.setItem("lexa:selectedProject", "gone");
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("slug").textContent).toBe("alpha"));
  });

  it("the route slug wins over the stored selection and persists it", async () => {
    localStorage.setItem("lexa:selectedProject", "alpha");
    routeSlug = "beta";
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("slug").textContent).toBe("beta"));
    expect(localStorage.getItem("lexa:selectedProject")).toBe("beta");
  });

  it("setSelectedSlug updates the context and persists", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("slug").textContent).toBe("alpha"));
    await act(async () => {
      screen.getByRole("button", { name: "pick beta" }).click();
    });
    expect(screen.getByTestId("slug").textContent).toBe("beta");
    expect(localStorage.getItem("lexa:selectedProject")).toBe("beta");
  });

  it("useProjectSelection outside the provider throws", () => {
    expect(() => render(<Probe />)).toThrow("useProjectSelection must be used within ProjectSelectionProvider");
  });
});
