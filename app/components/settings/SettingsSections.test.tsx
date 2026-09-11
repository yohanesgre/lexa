// @vitest-environment jsdom
// Wireframe settings-workspace.html: Machines table always renders (stable
// structure), runtime Team pill shows the team NAME (not the raw UUID), and
// the rate-limit copy names both /api and /mcp.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";
import type { Runtime } from "../../../shared/types";

const h = vi.hoisted(() => ({
  state: {
    runtimes: [] as unknown[],
    machines: [] as unknown[],
    teams: [] as unknown[],
    rateLimit: undefined as unknown,
  },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useRuntimes: () => ({ data: h.state.runtimes, isLoading: false, isError: false }),
    useMachines: () => ({ data: h.state.machines }),
    useTeams: () => ({ data: h.state.teams }),
    useRateLimit: () => ({ data: h.state.rateLimit, isLoading: false, isError: false }),
  };
});

vi.mock("../../lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { ApiKeyRevealModal, MachinesRuntimesSection, RateLimitSection } from "./SettingsSections";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
  );
}

beforeEach(() => {
  h.state.runtimes = [];
  h.state.machines = [];
  h.state.teams = [];
  h.state.rateLimit = undefined;
});

describe("MachinesRuntimesSection", () => {
  it("renders the Machines table even with no machines", () => {
    render(<MachinesRuntimesSection />, { wrapper: wrapper() });
    expect(screen.getByRole("columnheader", { name: "Machine" })).toBeInTheDocument();
    expect(screen.getByText(/No machines registered yet/)).toBeInTheDocument();
  });

  it("renders the team name on the runtime row, not the raw team id", () => {
    const runtime = {
      id: "r1",
      name: "dev-mbp",
      provider: "opencode",
      machineId: "m1",
      agent: "",
      model: "",
      printLogs: false,
      logLevel: "",
      extraArgs: [],
      modelsCatalog: [],
      agentsCatalog: [],
      status: "online",
      lastError: null,
      hostname: "dev-host.local",
      lastSeen: null,
      createdAt: "2026-01-01T00:00:00Z",
      teamId: "team-1",
    } as Runtime & { teamId: string };
    h.state.runtimes = [runtime];
    h.state.teams = [{ id: "team-1", name: "Core", slug: "core", createdAt: "2026-01-01T00:00:00Z" }];

    render(<MachinesRuntimesSection showTeamColumn />, { wrapper: wrapper() });

    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.queryByText("team-1")).not.toBeInTheDocument();
  });
});

describe("RateLimitSection", () => {
  it("names both /api and /mcp in the description", () => {
    h.state.rateLimit = { max: 6000, windowMs: 600000, envOverride: false };
    render(<RateLimitSection />, { wrapper: wrapper() });
    expect(screen.getByText(/Applies to \/api and \/mcp/)).toBeInTheDocument();
  });
});

describe("ApiKeyRevealModal", () => {
  it("makes the revealed key selectable as a manual-copy fallback", () => {
    const { container } = render(<ApiKeyRevealModal name="Hermes Staging" fullKey="lxk_abc123" onDone={vi.fn()} />, { wrapper: wrapper() });
    const code = container.querySelector("code") as HTMLElement;
    expect(code).toHaveTextContent("lxk_abc123");
    expect(code.style.userSelect).toBe("all");
  });
});
