// @vitest-environment jsdom
// /admin/assistant/ — Overview renders the full Gateway health block (the only
// gateway health surface as of 2026-09-27; Usage renders none).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

vi.mock("../../../lib/assistant-usage.query", () => ({
  useAssistantOverviewSummary: () => ({ data: { summary: null } }),
}));

const healthRow = {
  providerId: "p1", circuitState: "closed", failureCount: 0, consecutiveFailures: 0, openedAt: null,
  lastProbeAt: "2026-08-27 14:22:11", latencyMs: null, retryAfterSeconds: null, lastFailureCode: null,
  lastFailureAt: null, lastCheckedAt: "2026-08-27 14:22:11",
};

vi.mock("../../../lib/queries/assistant-admin", () => ({
  useAssistantRuns: () => ({ data: { data: [] } }),
  useAssistantProviders: () => ({
    data: [{ id: "p1", label: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", hasKey: true, keyMask: null, models: [] }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAssistantProvidersHealth: () => [{ data: healthRow, isPending: false, isError: false }],
  useProbeAssistantProvider: () => ({ isPending: false, variables: undefined, mutate: vi.fn(), isError: false, error: null }),
}));

vi.mock("../../../lib/queries", () => ({
  useProjects: () => ({ data: [] }),
}));

import { AssistantOverviewSection } from "./AssistantOverviewSection";

describe("AssistantOverviewSection gateway block", () => {
  it("renders the full Gateway health block (legend + provider rows), not a compact link", () => {
    const { container } = render(<AssistantOverviewSection />);
    expect(screen.getByText("Gateway health")).toBeInTheDocument();
    expect(screen.getByText("Opencode Go")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Test connection" }).length).toBeGreaterThanOrEqual(1);
    // Legend is full-variant only.
    expect(screen.getByText("Having trouble")).toBeInTheDocument();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();
    expect(container.querySelector("#gateway-health")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "View full health" })).not.toBeInTheDocument();
  });
});
