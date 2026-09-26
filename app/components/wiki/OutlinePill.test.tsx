// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutlinePill } from "./OutlinePill";

const HEADINGS = [
  { level: 1, text: "Home", id: "home" },
  { level: 2, text: "Basics", id: "basics" },
];

interface FakeObserver {
  callback: IntersectionObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
}
let observers: FakeObserver[] = [];

function stubIntersectionObserver() {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
  );
}

function makeMediaStub(options: { narrow: boolean; reducedMotion: boolean }) {
  return vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? options.reducedMotion : options.narrow,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }));
}

function controllableMatchMedia(options: { mobile: boolean; reducedMotion?: boolean }) {
  let mobile = options.mobile;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      const mobileQuery = query.includes("max-width: 767.98px");
      const motionQuery = query.includes("prefers-reduced-motion");
      return {
        get matches() {
          if (mobileQuery) return mobile;
          if (motionQuery) return options.reducedMotion ?? false;
          return false;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          if (mobileQuery) listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          if (mobileQuery) listeners.delete(listener);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent() {
          return false;
        },
      };
    })
  );
  return {
    toDesktop() {
      mobile = false;
      listeners.forEach((listener) => listener());
    },
  };
}

function interject(id: string) {
  act(() => {
    for (const observer of observers) {
      observer.callback(
        [{ isIntersecting: true, target: { id } } as unknown as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver
      );
    }
  });
}

function mountHeadingElements() {
  const h1 = document.createElement("h1");
  h1.id = "home";
  h1.setAttribute("data-test-heading", "");
  const h2 = document.createElement("h2");
  h2.id = "basics";
  h2.setAttribute("data-test-heading", "");
  document.body.append(h1, h2);
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stubIntersectionObserver();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-test-heading]").forEach((el) => el.remove());
  document.body.removeAttribute("data-scroll-lock");
  observers = [];
});

describe("OutlinePill visibility", () => {
  it("renders nothing when the outline has no h2+ section", () => {
    render(<OutlinePill headings={[{ level: 1, text: "Home", id: "home" }]} />);
    expect(document.querySelector(".wiki-outline-dock")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the current section label and updates it with the scroll-spy", () => {
    render(<OutlinePill headings={HEADINGS} />);
    expect(screen.getByRole("button", { name: "Home" })).toHaveTextContent("Home");

    interject("basics");
    expect(screen.getByRole("button", { name: "Basics" })).toHaveTextContent("Basics");
  });

  it("disconnects the scroll-spy observer on unmount", () => {
    const { unmount } = render(<OutlinePill headings={HEADINGS} />);
    expect(observers.length).toBeGreaterThan(0);
    const observer = observers[0]!;
    expect(observer.disconnect).not.toHaveBeenCalled();

    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("OutlinePill desktop popover", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", makeMediaStub({ narrow: false, reducedMotion: false }));
  });

  it("opens the popover, selects a row (scroll + close) and dismisses on Escape", () => {
    mountHeadingElements();
    render(<OutlinePill headings={HEADINGS} />);

    const pill = screen.getByRole("button", { name: "Home" });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pill);

    const panel = screen.getByRole("dialog", { name: "Contents" });
    expect(panel).toHaveClass("wiki-outline-panel");
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(pill).toHaveAttribute("aria-controls", "wiki-outline-panel");

    fireEvent.click(screen.getByText("Basics").closest("a")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });

    fireEvent.click(pill);
    expect(screen.getByRole("dialog", { name: "Contents" })).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("returns focus to the pill when the popover closes", () => {
    render(<OutlinePill headings={HEADINGS} />);
    const pill = screen.getByRole("button", { name: "Home" });
    act(() => pill.focus());

    fireEvent.click(pill);
    const panel = screen.getByRole("dialog", { name: "Contents" });
    expect(panel.contains(document.activeElement)).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.activeElement).toBe(pill);
  });

  it("closes on an outside mousedown without yanking focus back to the pill", () => {
    render(<OutlinePill headings={HEADINGS} />);
    const pill = screen.getByRole("button", { name: "Home" });
    act(() => pill.focus());

    fireEvent.click(pill);
    expect(screen.getByRole("dialog", { name: "Contents" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).not.toBe(pill);
  });

  it("jumps instantly when prefers-reduced-motion is set", () => {
    mountHeadingElements();
    vi.stubGlobal("matchMedia", makeMediaStub({ narrow: false, reducedMotion: true }));
    render(<OutlinePill headings={HEADINGS} />);

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByText("Basics").closest("a")!);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
  });
});

describe("OutlinePill mobile bottom sheet", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", makeMediaStub({ narrow: true, reducedMotion: false }));
  });

  it("opens as a sheet over a scrim, locks scroll and closes on scrim tap", () => {
    render(<OutlinePill headings={HEADINGS} />);
    const pill = screen.getByRole("button", { name: "Home" });
    fireEvent.click(pill);

    const sheet = screen.getByRole("dialog", { name: "Contents" });
    expect(sheet).toHaveClass("wiki-sheet");
    expect(pill).toHaveAttribute("aria-controls", "wiki-outline-sheet-mobile");
    expect(document.querySelector(".wiki-sheet-scrim")).toBeInTheDocument();
    expect(document.body.getAttribute("data-scroll-lock")).toBe("true");

    fireEvent.click(document.querySelector(".wiki-sheet-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.hasAttribute("data-scroll-lock")).toBe(false);
  });
});

describe("OutlinePill breakpoint", () => {
  it("closes an open sheet when the viewport crosses to desktop", () => {
    const media = controllableMatchMedia({ mobile: true });
    render(<OutlinePill headings={HEADINGS} />);

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(screen.getByRole("dialog", { name: "Contents" })).toHaveClass("wiki-sheet");

    act(() => media.toDesktop());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
