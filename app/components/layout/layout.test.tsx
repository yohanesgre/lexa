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
    // Settings is no longer a nav tab — settings entry points live in the
    // user menu and the project switcher.
    for (const label of ["Dashboard", "Board", "Tasks", "Wiki", "Milestones", "Swimlanes"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    // "Hearth" appears in the nav link and in ForgeStatus
    expect(screen.getAllByText("Hearth").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    // board route → the Board NavLink is active
    expect(screen.getByText("Board").className).toContain("active");
  });

  it("shows the signed-out Log in CTA in the user menu slot when there is no session", async () => {
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    expect(await screen.findByRole("link", { name: "Log in" })).toBeInTheDocument();
  });

  it("shows the user menu with role-scoped settings entries for a superadmin", async () => {
    routes.set("GET /api/auth/get-session", {
      session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" },
      user: { id: "u1", email: "y@lexa.test", name: "Yohanes", role: "superadmin", createdAt: "t", lastSeen: null },
    });
    const user = userEvent.setup();
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    await user.click(await screen.findByRole("button", { name: /Yohanes/ }));
    expect(screen.getByText("User settings")).toBeInTheDocument();
    expect(screen.getByText("Team settings")).toBeInTheDocument();
    expect(screen.getByText("Workspace settings")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });

  it("shows User settings only for a plain member", async () => {
    routes.set("GET /api/auth/get-session", {
      session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" },
      user: { id: "u1", email: "m@lexa.test", name: "M", role: "member", createdAt: "t", lastSeen: null },
    });
    const user = userEvent.setup();
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    await user.click(await screen.findByRole("button", { name: /M/ }));
    expect(screen.getByText("User settings")).toBeInTheDocument();
    expect(screen.queryByText("Team settings")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace settings")).not.toBeInTheDocument();
  });

  it("on /forge the brand is NOT active and the Hearth link IS active", () => {
    pathnameMock.value = "/forge";
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    expect(screen.getByText("Lexa").className).not.toContain("active");
    expect(screen.getByRole("link", { name: "Hearth" }).className).toContain("active");
    expect(screen.getByText("Dashboard").className).not.toContain("active");
  });

  it("on / the brand IS active and no nav link is", () => {
    pathnameMock.value = "/";
    render(<ProjectSelectionProvider><AppShell /></ProjectSelectionProvider>, { wrapper });
    expect(screen.getByText("Lexa").className).toContain("active");
    for (const label of ["Dashboard", "Board", "Tasks", "Wiki", "Milestones", "Swimlanes"]) {
      expect(screen.getByText(label).className).not.toContain("active");
    }
    expect(screen.getAllByRole("link", { name: "Hearth" })[0]!.className).not.toContain("active");
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
