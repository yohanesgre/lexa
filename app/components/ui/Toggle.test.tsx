// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("names the switch from a JSX label", () => {
    render(<Toggle checked={false} onChange={vi.fn()} label={<span>Notifications</span>} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Notifications");
  });

  it("prefers an explicit aria-label over the visible label", () => {
    render(<Toggle checked={false} onChange={vi.fn()} label={<span>Notifications</span>} ariaLabel="Alerts" />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Alerts");
  });

  it("toggles the checked state", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Notifications" />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
