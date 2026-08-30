// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "./DatePicker";

function renderPicker(props: Partial<Parameters<typeof DatePicker>[0]> = {}) {
  const onChange = vi.fn();
  render(<DatePicker value={null} onChange={onChange} {...props} />);
  return { onChange };
}

// Open the popover and return the rendered dialog element.
async function open(user: ReturnType<typeof userEvent.setup>, triggerName: RegExp) {
  await user.click(screen.getByRole("button", { name: triggerName }));
  return screen.findByRole("dialog", { name: "Pick a date" });
}

describe("DatePicker", () => {
  it("shows the placeholder when no value is set", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "No due date" })).toBeInTheDocument();
  });
  it("renders the calendar grid with the month label and weekday headers", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    const dialog = await screen.findByRole("dialog", { name: "Pick a date" });
    expect(dialog.textContent).toContain("August 2026");
    for (const w of ["S", "M", "T", "W", "T", "F", "S"]) {
      expect(dialog.textContent).toContain(w);
    }
    // 31 real days in August (muted overflow cells from adjacent months excluded)
    const realDays = screen.getAllByRole("button").filter((b) => /^\d{1,2}$/.test(b.textContent ?? "") && !b.className.includes("muted"));
    expect(realDays.length).toBe(31);
  });
});
