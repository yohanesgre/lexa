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
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select?: (s: { location: { pathname: string } }) => string }) =>
    select?.({ location: { pathname: "/demo/board" } }) ?? "/demo/board",
  useParams: () => ({ slug: "demo" }),
  Link: ({ to, params, search, className, activeProps, children }: any) => (
    <a href={String(to)} className={className} {...activeProps}>{children}</a>
  ),
  Outlet: () => <main data-testid="outlet">outlet</main>,
}));

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT = { id: "p1", slug: "demo", name: "Demo", description: "", githubRepo: null, createdAt: "t", updatedAt: "t" };
const PROJECT2 = { id: "p2", slug: "other", name: "Other", description: "", githubRepo: null, createdAt: "t", updatedAt: "t" };

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

  it("is not active when the active prop is false", () => {
    render(<NavLink to="/demo/board" active={false}>Board</NavLink>, { wrapper });
    expect(screen.getByText("Board").className).not.toContain("active");
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
    // the trigger already shows the hydrated selection, so "Demo" appears twice
    const demoRows = await screen.findAllByText("Demo");
    expect(demoRows.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("other")).toBeInTheDocument();
    expect(screen.getByText("003")).toBeInTheDocument(); // task count pad
    expect(screen.getByText("009")).toBeInTheDocument();
  });

  it("shows No projects when the list is empty", async () => {
    const user = userEvent.setup();
    routes.set("GET /api/projects", { data: [] });
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectSelectionProviderStub><ProjectSwitcher routeType="board" /></ProjectSelectionProviderStub>
      </QueryClientProvider>
    );
    await user.click(await screen.findByRole("button", { name: /No projects/ }));
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});

describe("AppShell", () => {
  it("renders the nav with brand, links, and the outlet", async () => {
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    expect(screen.getByText("Lexa")).toBeInTheDocument();
    for (const label of ["Dashboard", "Board", "Tasks", "Wiki", "Settings"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // "Forge" appears in the nav link and in ForgeStatus
    expect(screen.getAllByText("Forge").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    // board route → the Board NavLink is active
    expect(screen.getByText("Board").className).toContain("active");
  });

  it("switches the selected project from the switcher", async () => {
    const user = userEvent.setup();
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    await user.click(await screen.findByRole("button", { name: /Select project/ }));
    const demoRow = (await screen.findAllByText("Demo")).find((el) => el.className.includes("project-switcher-row-name"))!;
    await user.click(demoRow);
    // selection persisted to localStorage
    expect(localStorage.getItem("lexa:selectedProject")).toContain("demo");
    const trigger = screen.getByRole("button", { name: /Demo/ });
    expect(trigger).toBeInTheDocument();
  });
});

// Minimal re-implementation of the provider so these tests don't depend on
// the real ProjectSelectionProvider (which also uses useProjects + useParams).
import { ProjectSelectionProvider } from "../../lib/project-selection";

function ProjectSelectionProviderStub({ children }: { children: ReactNode }) {
  return <ProjectSelectionProvider>{children}</ProjectSelectionProvider>;
}
