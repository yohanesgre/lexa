// @vitest-environment jsdom
// Project settings → Linked repos type-ahead states
// (wireframes/src/settings-project-herald.html:57-185). LinkedReposSection is
// exported for test access (InlineDropdown precedent).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { GithubSettings, GithubInstallations } from "../../lib/api";

vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useNavigate: () => vi.fn(),
}));

const h = vi.hoisted(() => ({
  repos: { value: [] as Array<{ repo: string; sourceRole: boolean; workspaceRole: boolean }> },
  projects: { value: [] as Array<{ repos?: Array<{ repo: string }> }> },
  search: {
    value: { data: undefined as string[] | undefined, status: "success" as "pending" | "error" | "success", refetch: vi.fn() },
  },
  session: { value: { user: { role: "superadmin" } } as { user?: { role?: string } } | null },
  settings: { value: { appId: "1234567", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" } as GithubSettings | undefined },
  installations: { value: { status: "installed", accounts: ["acme-corp"] } as GithubInstallations | undefined },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useProjectRepos: () => ({ data: h.repos.value, isLoading: false }),
    useProjects: () => ({ data: h.projects.value }),
    useReplaceProjectRepos: () => ({ mutate: vi.fn(), isPending: false }),
    useGithubRepoSearch: () => h.search.value,
    useSession: () => ({ data: h.session.value }),
    useGithubSettings: () => ({ data: h.settings.value }),
    useGithubInstallations: () => ({ data: h.installations.value }),
  };
});

import { LinkedReposSection } from "./ProjectSettingsHub";

function typeQuery(value: string) {
  fireEvent.change(screen.getByLabelText("Search GitHub repos"), { target: { value } });
}

function settleDebounce() {
  act(() => { vi.advanceTimersByTime(300); });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.repos.value = [];
  h.projects.value = [];
  h.search.value = { data: undefined, status: "success", refetch: vi.fn() };
  h.session.value = { user: { role: "superadmin" } };
  h.settings.value = { appId: "1234567", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" };
  h.installations.value = { status: "installed", accounts: ["acme-corp"] };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("LinkedReposSection type-ahead", () => {
  it("idle — no dropdown before two characters", () => {
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("w");
    expect(screen.queryByText("Searching GitHub…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No repositories match/)).not.toBeInTheDocument();
  });

  it("idle — workspace suggestions stay available before a GitHub search fires", () => {
    h.projects.value = [{ repos: [{ repo: "acme/legacy" }] }];
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("a");
    expect(screen.getByText("Linked in workspace")).toBeInTheDocument();
    expect(screen.getByText("acme/legacy")).toBeInTheDocument();
  });

  it("searching — 300ms debounce pending before one request fires", () => {
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    expect(screen.getByText("Searching GitHub…")).toBeInTheDocument();
    settleDebounce();
    expect(screen.queryByText("Searching GitHub…")).not.toBeInTheDocument();
  });

  it("results — settled search renders the GitHub repos group", () => {
    h.search.value = { data: ["acme/web-client"], status: "success", refetch: vi.fn() };
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    settleDebounce();
    expect(screen.getByText("acme/web-client")).toBeInTheDocument();
    expect(screen.getByText("GitHub repos")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("no matches — settled 200 with an empty result set", () => {
    h.search.value = { data: [], status: "success", refetch: vi.fn() };
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    settleDebounce();
    expect(screen.getByText(/No repositories match/)).toBeInTheDocument();
  });

  it("no installation — the probe reports a connected-but-not-installed App, with the Install App CTA", () => {
    h.installations.value = { status: "not_installed", accounts: [] };
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    settleDebounce();
    expect(screen.getByText("No GitHub App installation found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Install App" })).toHaveAttribute("href", "https://github.com/apps/lexa-nimbus/installations/new");
  });

  it("no installation — members see the state without the Install App button", () => {
    h.session.value = { user: { role: "member" } };
    h.installations.value = { status: "not_installed", accounts: [] };
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    settleDebounce();
    expect(screen.getByText("No GitHub App installation found")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Install App" })).not.toBeInTheDocument();
    expect(screen.getByText(/Superadmin only — members' repo search is denied and shows the error state/)).toBeInTheDocument();
  });

  it("error — an upstream failure never renders as silent emptiness", () => {
    h.search.value = { data: [], status: "error", refetch: vi.fn() };
    render(<LinkedReposSection slug="nimbus" />);
    typeQuery("web");
    settleDebounce();
    expect(screen.getByText("Couldn't load repositories")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong loading repositories. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
