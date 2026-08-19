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

  it("navigates months with the prev/next buttons", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    const dialog = await screen.findByRole("dialog", { name: "Pick a date" });
    expect(dialog.textContent).toContain("August 2026");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(dialog.textContent).toContain("July 2026");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(dialog.textContent).toContain("September 2026");
  });

  it("clicking a day calls onChange with the ISO date", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    const day = (await screen.findAllByRole("button", { name: "15" }))[0]!;
    await user.click(day);
    expect(onChange).toHaveBeenCalledWith("2026-08-15");
  });

  it("marks the selected day with the selected class", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    const day = (await screen.findAllByRole("button", { name: "15" }))[0]!;
    expect(day.className).toContain("selected");
  });

  it("Clear calls onChange(null) — only when a value is set", async () => {
    const user = userEvent.setup();
    const withValue = renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(withValue.onChange).toHaveBeenCalledWith(null);

    const withoutValue = renderPicker({ value: null });
    await user.click(screen.getByRole("button", { name: "No due date" }));
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(withoutValue.onChange).not.toHaveBeenCalled();
  });

  it("Today calls onChange with the current date and closes the popover", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await user.click(await screen.findByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(screen.queryByRole("dialog", { name: "Pick a date" })).not.toBeInTheDocument();
  });

  it("Today renders even when no value is set", async () => {
    const user = userEvent.setup();
    renderPicker({ value: null });
    await user.click(screen.getByRole("button", { name: "No due date" }));
    expect(await screen.findByRole("button", { name: "Today" })).toBeInTheDocument();
  });

  it("Escape closes the popover", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "2026-08-15" });
    await open(user, /2026-08-15/);
    expect(await screen.findByRole("dialog", { name: "Pick a date" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Pick a date" })).not.toBeInTheDocument();
  });
});
