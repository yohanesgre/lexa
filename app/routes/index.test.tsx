// @vitest-environment jsdom
// Home — a failed create surfaces the error element (acceptance #3: visible
// error). Mounts the real route component against a failing POST /api/projects.
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { Dashboard, Project, Team } from "../../shared/types";
import { createFetchMock, createTestQueryClient, json } from "../test-utils";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => ({}) }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

import { ToastProvider } from "../components/ui/Toast";
import { ProjectSelectionProvider } from "../lib/project-selection";
import { Home } from "./index";

const { fetchMock, routes } = createFetchMock();

const TEAM: Team = { id: "team1", name: "Core", slug: "core", createdAt: "t" };
const PROJECT: Project = { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const DASHBOARD: Dashboard = {
  projects: [{ project: PROJECT, taskCount: 2, columnCount: 1, urgentCount: 0, syncCount: 0, health: "ok", wipSegments: [] }],
  stats: { totalTasks: 2, activeProjects: 1, wipExceeded: 0, outOfSync: 0 },
  urgentTasks: [],
  outOfSyncTasks: [],
};

let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  routes.set("GET /api/dashboard", DASHBOARD);
  routes.set("GET /api/projects", { data: [PROJECT], nextCursor: null });
  routes.set("GET /api/teams", { data: [TEAM] });
  routes.set("GET /api/setup/status", { configured: true, needsAdmin: false, hasProjects: true, hasUsers: true });
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/projects") {
      return Promise.resolve(json({ error: { code: "SLUG_TAKEN", message: "Slug already taken" } }, 409));
    }
    const hit = routes.get(`${method} ${url}`) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${method} ${url}`));
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(hit));
  });
  queryClient = createTestQueryClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderHome() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProjectSelectionProvider>
          <Home />
        </ProjectSelectionProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe("Home", () => {
  it("renders the create-project error in .dashboard-error when POST /api/projects fails", async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole("heading", { name: "Projects" });

    await user.click(screen.getByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Name"), "Other");
    await user.selectOptions(screen.getByLabelText("Project team"), "team1");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    const error = await screen.findByText("Slug already taken", { selector: ".dashboard-error" });
    expect(error).toHaveClass("dashboard-error");
    // The failure toast is surfaced too.
    expect(await screen.findByText("Failed to create project")).toBeInTheDocument();
  });
});
