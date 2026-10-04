// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DatePicker } from "./DatePicker";

describe("DatePicker", () => {
  it("selects the correct next-month date from a muted trailing cell", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-08-14" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /2026-08-14/ }));

    const trailing = document.querySelectorAll<HTMLButtonElement>(".datepicker-day.muted");
    expect(trailing.length).toBeGreaterThan(0);
    expect(trailing[0]).toHaveTextContent("1");

    fireEvent.click(trailing[0]!);
    expect(onChange).toHaveBeenCalledWith("2026-09-01");
  });

  it("selects the correct next-month date across a year boundary", () => {
    const onChange = vi.fn();
    render(<DatePicker value="2026-12-15" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /2026-12-15/ }));

    const trailing = document.querySelectorAll<HTMLButtonElement>(".datepicker-day.muted");
    expect(trailing[0]).toHaveTextContent("1");

    fireEvent.click(trailing[0]!);
    expect(onChange).toHaveBeenCalledWith("2027-01-01");
  });
});
