// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageKpiCards } from "./UsageKpiCards";
import type { HeraldUsageSummary } from "../../lib/herald-usage.query";

function summary(overrides: Partial<HeraldUsageSummary> = {}): HeraldUsageSummary {
  return {
    totalTokens: 1_482_391,
    promptTokens: 892_100,
    completionTokens: 590_291,
    totalCostCents: 4218,
    totalCostUsd: 42.18,
    avgLatencyMs: 1240,
    p50LatencyMs: 890,
    p95LatencyMs: 2410,
    errorRate: 0.008,
    totalCalls: 1482,
    errorCalls: 12,
    ...overrides,
  };
}

describe("UsageKpiCards latency", () => {
  it("renders the real p50/p95 values (admin-herald-usage.html:55)", () => {
    render(<UsageKpiCards summary={summary()} />);
    expect(screen.getByText("p50 890 · p95 2,410 ms")).toBeInTheDocument();
    expect(screen.getByText("1,240 ms")).toBeInTheDocument();
  });

  it("falls back to em dashes when percentiles are null", () => {
    render(<UsageKpiCards summary={summary({ avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null })} />);
    expect(screen.getByText("p50 — · p95 — ms")).toBeInTheDocument();
  });
});
