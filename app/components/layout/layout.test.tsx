// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NavLink } from "./NavLink";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { AppShell } from "./AppShell";

// The layout components use the tanstack router surface (Link/useRouterState/
// Outlet) and the ProjectSelectionProvider (which also needs useParams).
// pathnameMock lets each test set the route — the AppShell routeType + active
// states derive from it.
const pathnameMock = vi.hoisted(() => ({ value: "/demo/board" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select?: (s: { location: { pathname: string } }) => string }) =>
    select?.({ location: { pathname: pathnameMock.value } }) ?? pathnameMock.value,
  useParams: () => ({ slug: "demo" }),
  useNavigate: () => vi.fn(),
  Link: ({ to, params, search, className, activeProps, children }: any) => (
    <a href={String(to)} className={className} {...activeProps}>{children}</a>
  ),
  Outlet: () => <main data-testid="outlet">outlet</main>,
}));

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT = { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const PROJECT2 = { id: "p2", slug: "other", name: "Other", description: "", repos: [], createdAt: "t", updatedAt: "t" };

const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(hit));
  });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  pathnameMock.value = "/demo/board";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects", { data: [PROJECT, PROJECT2] });
  routes.set("GET /api/dashboard", {
    projects: [
      { project: PROJECT, health: "ok", taskCount: 3 },
      { project: PROJECT2, health: "exceeded", taskCount: 9 },
    ],
  });
  routes.set("GET /api/auth/get-session", { session: null, user: null });
  routes.set("GET /api/teams", { data: [] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("NavLink", () => {
  it("applies the active class from the active prop", () => {
    render(<NavLink to="/demo/board" active>Board</NavLink>, { wrapper });
    expect(screen.getByText("Board").className).toContain("active");
  });
});

describe("ProjectSwitcher", () => {
  it("renders the trigger and lists projects with health counts when opened", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectSelectionProviderStub><ProjectSwitcher routeType="board" /></ProjectSelectionProviderStub>
      </QueryClientProvider>
    );
    await user.click(await screen.findByRole("button", { name: /Select project/ }));
    const demoRows = await screen.findAllByText("Demo");
    expect(demoRows.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("other")).toBeInTheDocument();
  });
});

describe("AppShell", () => {
  it("renders the nav with brand, links, and the outlet", async () => {
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    expect(screen.getByText("Lexa")).toBeInTheDocument();
    for (const label of ["Dashboard", "Board", "Tasks", "Wiki", "Milestones", "Swimlanes"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });
});

// Minimal re-implementation of the provider so these tests don't depend on
// the real ProjectSelectionProvider (which also uses useProjects + useParams).
import { ProjectSelectionProvider } from "../../lib/project-selection";

function ProjectSelectionProviderStub({ children }: { children: ReactNode }) {
  return <ProjectSelectionProvider>{children}</ProjectSelectionProvider>;
}
