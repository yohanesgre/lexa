// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Menu } from "./Menu";

function renderMenu() {
  render(
    <Menu
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle}>Open</button>
      )}
    >
      <button type="button" className="menu-item">One</button>
      <button type="button" className="menu-item">Two</button>
    </Menu>
  );
}

describe("Menu", () => {
  it("keeps the menu open until Escape or an item click", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves focus through items with arrow keys", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    // Opening moves focus into the popover, so keydowns on an item reach the
    // menu's key handler the way a real keyboard user's would.
    const one = screen.getByRole("button", { name: "One" });
    expect(one).toHaveFocus();

    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Two" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "One" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "One" }), { key: "End" });
    expect(screen.getByRole("button", { name: "Two" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Two" }), { key: "Home" });
    expect(screen.getByRole("button", { name: "One" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "One" }), { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Two" })).toHaveFocus();
  });

  it("closes on Escape from inside the menu and restores focus to the trigger", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "One" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("re-anchors the popover on window scroll", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Open" });
    const anchor = trigger.parentElement!;
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      top: 10, bottom: 40, left: 20, right: 80, width: 60, height: 30,
      x: 20, y: 10, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveStyle({ top: "48px" });

    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      top: 110, bottom: 140, left: 20, right: 80, width: 60, height: 30,
      x: 20, y: 110, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);
    expect(menu).toHaveStyle({ top: "148px" });
  });
});
