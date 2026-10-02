// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revisionsState = vi.hoisted(() => ({
  data: [] as Array<{ id: string; createdAt: string; saveType: string }>,
  isLoading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useRevisions: () => revisionsState,
}));

import { PageSettingsPanel } from "./PageSettingsPanel";
import { controllableMatchMedia, stubMatchMedia } from "../../test-utils";

function rev(id: string, hoursAgo: number, saveType = "autosave") {
  return {
    id,
    createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    saveType,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof PageSettingsPanel>[0]> = {}) {
  const props = {
    slug: "demo",
    pageSlug: "home",
    autosaveEnabled: false,
    autosaveDelay: 800,
    onAutosaveChange: vi.fn(),
    onDelayChange: vi.fn(),
    selectedRevisionId: null,
    onSelectRevision: vi.fn(),
    onRestore: vi.fn(),
    onClosePreview: vi.fn(),
    restoring: false,
    ...overrides,
  };
  return { props, ...render(<PageSettingsPanel {...props} />) };
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Page settings" }));
}

beforeEach(() => {
  revisionsState.data = [];
  revisionsState.isLoading = false;
  revisionsState.error = null;
  revisionsState.refetch = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-test-heading]").forEach((el) => el.remove());
  document.body.removeAttribute("data-scroll-lock");
});

describe("PageSettingsPanel trigger", () => {
  it("names the icon-only trigger with a CSS-independent accessible label", () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "Page settings" });
    expect(trigger).toHaveAccessibleName("Page settings");
    expect(trigger).toHaveAttribute("aria-label", "Page settings");
  });
});

describe("PageSettingsPanel autosave", () => {
  it("reveals the delay chips when autosave turns on and calls the handlers", () => {
    const { props, rerender } = renderPanel();
    openPanel();

    const toggle = screen.getByRole("button", { name: "Autosave" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "500 ms" })).toBeNull();

    fireEvent.click(toggle);
    expect(props.onAutosaveChange).toHaveBeenCalledWith(true);

    rerender(<PageSettingsPanel {...props} autosaveEnabled />);
    expect(screen.getByRole("button", { name: "800 ms" })).toHaveClass("is-active");
    fireEvent.click(screen.getByRole("button", { name: "1500 ms" }));
    expect(props.onDelayChange).toHaveBeenCalledWith(1500);
  });
});

describe("PageSettingsPanel version history", () => {
  it("previews an older revision and keeps the desktop popover open", () => {
    revisionsState.data = [rev("r1", 2), rev("r2", 5, "manual")];
    const { props } = renderPanel();
    openPanel();

    const newest = screen.getByText("2 hours ago").closest("button")!;
    expect(newest).toHaveClass("active");
    expect(within(newest).getByText("Previewing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close preview" })).toBeEnabled();

    const older = screen.getByText("5 hours ago").closest("button")!;
    fireEvent.click(older);
    expect(props.onSelectRevision).toHaveBeenCalledWith("r2");
    expect(screen.getByRole("dialog", { name: "Page settings" })).toBeInTheDocument();
  });

  it("auto-closes the sheet after selecting a revision on a mobile viewport", () => {
    stubMatchMedia(true);
    revisionsState.data = [rev("r1", 2), rev("r2", 5)];
    const { props } = renderPanel();
    openPanel();

    expect(screen.getByRole("dialog", { name: "Page settings" })).toHaveClass("wiki-sheet");
    fireEvent.click(screen.getByText("5 hours ago").closest("button")!);
    expect(props.onSelectRevision).toHaveBeenCalledWith("r2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores the selected revision and shows the pending label", () => {
    revisionsState.data = [rev("r1", 2), rev("r2", 5)];
    const { props, rerender } = renderPanel({ selectedRevisionId: "r2", restoring: true });
    openPanel();

    expect(screen.getByRole("button", { name: "Restoring…" })).toBeDisabled();
    const close = screen.getByRole("button", { name: "Close preview" });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(props.onClosePreview).toHaveBeenCalledTimes(1);

    rerender(<PageSettingsPanel {...props} restoring={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(props.onRestore).toHaveBeenCalledWith("r2");
  });

  it("renders three skeleton rows while versions load", () => {
    revisionsState.isLoading = true;
    renderPanel();
    openPanel();

    const list = document.querySelector(".history-list");
    expect(list?.querySelectorAll(".skeleton")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("renders the error state and retries the revisions query", () => {
    revisionsState.error = new Error("boom");
    renderPanel();
    openPanel();

    expect(screen.getByText("Failed to load versions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(revisionsState.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("renders the empty state without restore actions", () => {
    renderPanel();
    openPanel();

    expect(screen.getByText("No previous versions yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close preview" })).toBeNull();
  });
});

describe("PageSettingsPanel focus", () => {
  it("moves focus into the panel and returns it to the button on close", () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "Page settings" });
    act(() => trigger.focus());
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "Page settings" });
    expect(panel.contains(document.activeElement)).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside mousedown without yanking focus back to the trigger", () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: "Page settings" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Page settings" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });
});

describe("PageSettingsPanel breakpoint", () => {
  it("closes an open sheet when the viewport crosses to desktop", () => {
    const media = controllableMatchMedia({ mobile: true });
    renderPanel();
    openPanel();

    expect(screen.getByRole("dialog", { name: "Page settings" })).toHaveClass("wiki-sheet");

    act(() => media.toDesktop());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
