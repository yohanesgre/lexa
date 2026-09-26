// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/queries", () => ({
  useRevisions: () => ({ data: [], isLoading: false, error: null }),
}));

import { EditSidebar } from "./EditSidebar";

function renderSidebar(overrides: Partial<Parameters<typeof EditSidebar>[0]> = {}) {
  const props = {
    slug: "demo",
    pageSlug: "home",
    autosaveEnabled: false,
    autosaveDelay: 800,
    onAutosaveChange: vi.fn(),
    onDelayChange: vi.fn(),
    open: true,
    onToggle: vi.fn(),
    selectedRevisionId: null,
    onSelectRevision: vi.fn(),
    onRestore: vi.fn(),
    onClosePreview: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<EditSidebar {...props} />) };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.removeAttribute("data-scroll-lock");
});

describe("EditSidebar rail", () => {
  it("renders the 36px rail toggle with aria wiring when closed", () => {
    const { props } = renderSidebar({ open: false });

    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "wiki-page-settings");
    expect(document.querySelector(".wiki-edit-sidebar-rail")).toBeInTheDocument();
    expect(document.getElementById("wiki-page-settings")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("EditSidebar open panel", () => {
  it("renders the collapse toggle with the right-edge glyph", () => {
    renderSidebar();

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "wiki-page-settings");
    expect(toggle.querySelector("path")).toHaveAttribute("d", "M15 3v18");
    expect(document.querySelector(".wiki-edit-sidebar")).toBeInTheDocument();
  });
});

describe("EditSidebar mobile overlay", () => {
  it("opens as a modal overlay with a scrim, closing on Escape and scrim tap", () => {
    const { props, rerender } = renderSidebar({ overlayActive: true });

    const panel = document.getElementById("wiki-page-settings")!;
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(document.body.getAttribute("data-scroll-lock")).toBe("true");

    const scrim = document.querySelector(".wiki-sidebar-backdrop");
    expect(scrim).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(props.onToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(scrim!);
    expect(props.onToggle).toHaveBeenCalledTimes(2);

    rerender(<EditSidebar {...props} overlayActive={false} />);
    expect(document.querySelector(".wiki-sidebar-backdrop")).toBeNull();
  });

  it("moves focus into the overlay and returns it to the trigger on close", () => {
    const { props, rerender } = renderSidebar();

    const autosave = screen.getByRole("button", { name: "Autosave off" });
    act(() => autosave.focus());
    expect(document.activeElement).toBe(autosave);

    rerender(<EditSidebar {...props} overlayActive />);
    const panel = document.getElementById("wiki-page-settings")!;
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(autosave);

    rerender(<EditSidebar {...props} overlayActive={false} />);
    expect(document.activeElement).toBe(autosave);
  });
});
