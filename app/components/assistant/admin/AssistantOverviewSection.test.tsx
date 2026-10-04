// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

vi.mock("../GatewayHealthSection", () => ({ GatewayHealthSection: () => null }));

vi.mock("../../../lib/queries", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("../../../lib/assistant-usage.query", () => ({ useAssistantOverviewSummary: vi.fn() }));
vi.mock("../../../lib/queries/assistant-admin", () => ({ useAssistantRuns: vi.fn() }));

import { AssistantOverviewSection } from "./AssistantOverviewSection";
import { useAssistantOverviewSummary } from "../../../lib/assistant-usage.query";
import { useAssistantRuns } from "../../../lib/queries/assistant-admin";

const summaryMock = vi.mocked(useAssistantOverviewSummary);
const runsMock = vi.mocked(useAssistantRuns);

describe("AssistantOverviewSection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows usage skeleton cards and run skeleton rows while loading", () => {
    summaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() } as never);
    runsMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() } as never);
    render(<AssistantOverviewSection />);
    expect(screen.getAllByText("Loading…").length).toBe(4);
    expect(document.querySelectorAll("tbody td .skeleton").length).toBe(3);
  });

  it("surfaces the usage and runs error states with working Retry buttons", async () => {
    const refetchUsage = vi.fn();
    const refetchRuns = vi.fn();
    summaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: refetchUsage } as never);
    runsMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: refetchRuns } as never);
    const user = userEvent.setup();
    render(<AssistantOverviewSection />);
    expect(screen.getByText("Usage summary unavailable")).toBeTruthy();
    expect(screen.getByText("Couldn't load usage metrics.")).toBeTruthy();
    expect(screen.getByText("Failed to load runs.")).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(2);
    await user.click(retries[0]!);
    expect(refetchUsage).toHaveBeenCalledTimes(1);
    await user.click(retries[1]!);
    expect(refetchRuns).toHaveBeenCalledTimes(1);
  });
});
