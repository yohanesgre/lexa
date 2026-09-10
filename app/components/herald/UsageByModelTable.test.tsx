// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsageByModelTable } from "./UsageByModelTable";
import type { HeraldByModelRow } from "../../lib/herald-usage.query";

const row = (over: Partial<HeraldByModelRow> & { model: string }): HeraldByModelRow => ({
  tokens: 0,
  costCents: 0,
  costUsd: 0,
  avgLatencyMs: null,
  calls: 0,
  errorRate: 0,
  ...over,
});

function bodyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll("tbody tr")) as HTMLTableRowElement[];
}

describe("UsageByModelTable", () => {
  it("renders zero-call rows muted/italic with — placeholders and Calls 0", () => {
    render(<UsageByModelTable byModel={[row({ model: "meta-llama/llama-4-maverick" })]} />);
    const tr = bodyRows()[0]!;
    const cells = Array.from(tr.querySelectorAll("td")) as HTMLTableCellElement[];
    const modelCell = cells[0]!;
    expect(modelCell.textContent).toBe("meta-llama/llama-4-maverick");
    expect(modelCell.style.fontStyle).toBe("italic");
    expect(modelCell.className).toContain("color-muted");
    expect(cells[1]!.textContent).toBe("—");
    expect(cells[2]!.textContent).toBe("—");
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[4]!.textContent).toBe("0");
    expect(cells[5]!.textContent).toBe("—");
  });

  it("sorts rows by tokens DESC", () => {
    render(
      <UsageByModelTable
        byModel={[
          row({ model: "small", tokens: 100, calls: 1, costUsd: 1 }),
          row({ model: "big", tokens: 900, calls: 2, costUsd: 9 }),
        ]}
      />,
    );
    const models = bodyRows().map((tr) => tr.querySelector("td")!.textContent);
    expect(models).toEqual(["big", "small"]);
  });

  it("uses the wireframe fixed px column widths", () => {
    render(<UsageByModelTable byModel={[]} />);
    const ths = Array.from(document.querySelectorAll("thead th")) as HTMLTableCellElement[];
    expect(ths.map((th) => th.style.width)).toEqual(["auto", "110px", "110px", "110px", "80px", "90px"]);
  });

  it("renders the empty state when there is no data", () => {
    render(<UsageByModelTable byModel={[]} summary={null} />);
    expect(screen.getByText("No usage for this window")).toBeTruthy();
  });
});
