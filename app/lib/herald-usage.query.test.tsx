// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHeraldUsage, exportHeraldUsageCsv } from "./herald-usage.query";
import { UsageKpiCards } from "../components/herald/UsageKpiCards";
import { UsageByModelTable } from "../components/herald/UsageByModelTable";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const mockUsage = {
  summary: { totalTokens: 1482391, promptTokens: 892100, completionTokens: 590291, totalCostCents: 4218, totalCostUsd: 42.18, avgLatencyMs: 1240, errorRate: 0.008, totalCalls: 1482, errorCalls: 12 },
  totalCostCents: 4218,
  byDay: [{ day: "2026-08-01", tokens: 500, costCents: 100, costUsd: 1, avgLatencyMs: 800, calls: 2, errorRate: 0 }],
  byModel: [{ model: "anthropic/claude-sonnet-4", tokens: 892400, costCents: 2842, costUsd: 28.42, avgLatencyMs: 1120, calls: 834, errorRate: 0.004 }],
};

describe("useHeraldUsage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetches usage and renders KPI cards", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => mockUsage }));
    function Probe() {
      const q = useHeraldUsage({});
      if (q.isLoading) return <div>loading</div>;
      if (q.data) return <UsageKpiCards summary={q.data.summary} />;
      return <div>empty</div>;
    }
    render(<Probe />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("1,482,391")).toBeTruthy());
    expect(screen.getByText("$42.18")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/admin/herald/usage"), expect.anything());
  });
  it("builds query with from/to/projectId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockUsage });
    vi.stubGlobal("fetch", fetchMock);
    function Probe() {
      const q = useHeraldUsage({ from: "2026-08-01", to: "2026-08-27", projectId: "p1" });
      return <div>{q.isLoading ? "loading" : "done"}</div>;
    }
    render(<Probe />, { wrapper: wrapper() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("from=2026-08-01");
    expect(url).toContain("to=2026-08-27");
    expect(url).toContain("projectId=p1");
  });
});
