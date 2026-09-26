// @vitest-environment jsdom
// /admin/assistant/usage — the shell owns the header, tab bar, and superadmin
// gate; this route renders the usage body only (plus the surfaced calls table).
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => ({ ...(opts as object), useSearch: () => ({}) }),
  Navigate: () => <div data-testid="navigate-away" />,
}));

vi.mock("../lib/assistant-usage.query", () => ({
  useAssistantUsage: () => ({ data: { summary: null, byDay: [], byModel: [] }, isLoading: false, error: null, refetch: vi.fn() }),
  exportAssistantUsageCsv: vi.fn(),
}));

vi.mock("../components/assistant/UsageKpiCards", () => ({ UsageKpiCards: () => <div data-testid="usage-kpi" /> }));
vi.mock("../components/assistant/UsageChart", () => ({ UsageChart: () => null }));
vi.mock("../components/assistant/UsageByModelTable", () => ({ UsageByModelTable: () => null }));
vi.mock("../components/assistant/PriceEditor", () => ({ PriceEditor: () => null }));
vi.mock("../components/assistant/admin/AssistantCallsTable", () => ({ AssistantCallsTable: () => <div data-testid="calls-table" /> }));

import { AssistantUsageRoute } from "./admin.assistant.usage";

describe("admin.assistant.usage body", () => {
  it("renders the usage body and the calls table without page chrome", () => {
    render(<AssistantUsageRoute />);
    expect(screen.getByText("Filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
    expect(screen.getByTestId("usage-kpi")).toBeInTheDocument();
    expect(screen.getByTestId("calls-table")).toBeInTheDocument();
    expect(screen.queryByText("Assistant usage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("navigate-away")).not.toBeInTheDocument();
  });
});
