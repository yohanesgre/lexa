// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutlineSidebar } from "./OutlineSidebar";

const HEADINGS = [
  { level: 1, text: "Home", id: "home" },
  { level: 2, text: "Basics", id: "basics" },
];

// jsdom reports no client rects, so the focus trap's visibility filter would
// drop every candidate. Treat elements as visible for these tests.
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.removeAttribute("data-scroll-lock");
});

describe("OutlineSidebar rail", () => {
  it("renders the 36px rail toggle with aria wiring when closed", () => {
    const onToggle = vi.fn();
    render(<OutlineSidebar headings={HEADINGS} open={false} onToggle={onToggle} />);

    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "wiki-outline");
    expect(document.querySelector(".outline-sidebar-rail")).toBeInTheDocument();
    expect(document.getElementById("wiki-outline")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("OutlineSidebar open panel", () => {
  it("renders the collapse toggle with the right-edge glyph", () => {
    render(<OutlineSidebar headings={HEADINGS} open onToggle={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "wiki-outline");
    expect(toggle.querySelector("path")).toHaveAttribute("d", "M15 3v18");
    expect(document.querySelector(".outline-sidebar-open")).toBeInTheDocument();
  });
});

describe("OutlineSidebar mobile overlay", () => {
  it("opens as a modal overlay with a scrim, closing on Escape and scrim tap", () => {
    const onToggle = vi.fn();
    render(<OutlineSidebar headings={HEADINGS} open onToggle={onToggle} overlayActive />);

    const panel = document.getElementById("wiki-outline")!;
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(document.body.getAttribute("data-scroll-lock")).toBe("true");

    const scrim = document.querySelector(".wiki-sidebar-backdrop");
    expect(scrim).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(scrim!);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the overlay and returns it to the remounted rail toggle on close", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<OutlineSidebar headings={HEADINGS} open={false} onToggle={onToggle} />);

    const railToggle = screen.getByRole("button", { name: "Expand sidebar" });
    act(() => railToggle.focus());
    expect(document.activeElement).toBe(railToggle);

    rerender(<OutlineSidebar headings={HEADINGS} open onToggle={onToggle} overlayActive />);
    const panel = document.getElementById("wiki-outline")!;
    expect(panel.contains(document.activeElement)).toBe(true);

    rerender(<OutlineSidebar headings={HEADINGS} open={false} onToggle={onToggle} />);
    const remounted = screen.getByRole("button", { name: "Expand sidebar" });
    expect(document.activeElement).toBe(remounted);
  });
});
