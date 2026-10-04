// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SelectDropdown } from "./SelectDropdown";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

function renderDropdown(onChange = vi.fn()) {
  render(
    <SelectDropdown
      value="a"
      options={OPTIONS}
      onChange={onChange}
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle}>Open</button>
      )}
    />
  );
  return onChange;
}

describe("SelectDropdown", () => {
  it("exposes listbox/option semantics with the selected option marked", () => {
    renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute("aria-selected", "false");
  });

  it("moves roving focus with arrow keys and selects with Enter", () => {
    const onChange = renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const listbox = screen.getByRole("listbox");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveFocus();

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Beta" })).toHaveFocus();

    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
