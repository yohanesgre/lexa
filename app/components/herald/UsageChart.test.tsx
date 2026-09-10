// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsageChart } from "./UsageChart";
import type { HeraldByDayRow } from "../../lib/herald-usage.query";

const rows: HeraldByDayRow[] = [
  { day: "2026-08-01", tokens: 1200, costCents: 12, costUsd: 0.12, avgLatencyMs: 800, calls: 4, errorRate: 0 },
  { day: "2026-08-02", tokens: 3400, costCents: 30, costUsd: 0.3, avgLatencyMs: 950, calls: 7, errorRate: 0.14 },
  { day: "2026-08-03", tokens: 900, costCents: 8, costUsd: 0.08, avgLatencyMs: null, calls: 2, errorRate: 0 },
];

function makeCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 12 })),
    save: vi.fn(),
    restore: vi.fn(),
    closePath: vi.fn(),
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
  };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("UsageChart", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a canvas and draws both series from byDay", async () => {
    render(<UsageChart byDay={rows} />);
    const canvas = document.querySelector("canvas#herald-by-day");
    expect(canvas).toBeTruthy();
    await waitFor(() => expect(ctx.arc).toHaveBeenCalledTimes(rows.length * 2));
    expect(ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(rows.length * 2 - 2);
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("shows a per-day tooltip on hover", async () => {
    render(<UsageChart byDay={rows} />);
    await waitFor(() => expect(ctx.arc).toHaveBeenCalled());
    const canvas = document.querySelector("canvas#herald-by-day")!;
    fireEvent.mouseMove(canvas, { clientX: 52, clientY: 40 });
    const tooltip = await screen.findByTestId("herald-chart-tooltip");
    expect(tooltip.textContent).toContain("2026-08-01");
    expect(tooltip.textContent).toContain("1,200");
    expect(tooltip.textContent).toContain("$0.120");
    expect(tooltip.textContent).toContain("800 ms");
    expect(tooltip.textContent).toContain("error_rate 0.00 %");
    fireEvent.mouseLeave(canvas);
    await waitFor(() => expect(screen.queryByTestId("herald-chart-tooltip")).toBeNull());
  });

  it("keeps axes and shows empty message with no rows", async () => {
    render(<UsageChart byDay={[]} />);
    expect(await screen.findByText("No data for this window")).toBeTruthy();
    await waitFor(() => expect(ctx.fillText).toHaveBeenCalled());
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(screen.getByText("tokens")).toBeTruthy();
    expect(screen.getByText("cost")).toBeTruthy();
  });

  it("shows loading overlay without drawing series", async () => {
    render(<UsageChart byDay={rows} isLoading />);
    expect(await screen.findByText("Loading chart…")).toBeTruthy();
  });

  it("shows error overlay and Retry fires onRetry", async () => {
    const onRetry = vi.fn();
    render(<UsageChart byDay={rows} isError onRetry={onRetry} />);
    expect(await screen.findByText("Failed to load chart")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
