// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarState } from "./sidebar-state";

function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "(min-width: 768px)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return {
    set(next: boolean) {
      matches = next;
      const event = { matches: next, media: mql.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function StateProbe() {
  const state = useSidebarState({ storageKey: "k", defaultOpen: true });
  return <div data-open={String(state.open)} data-overlay={String(state.overlayActive)} />;
}

describe("useSidebarState", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders closed with no overlay in the server snapshot (pre-hydration)", () => {
    const html = renderToString(<StateProbe />);
    expect(html).toContain('data-open="false"');
    expect(html).toContain('data-overlay="false"');
  });

  it("persists desktop intent across remounts", () => {
    mockMatchMedia(true);
    const first = renderHook(() => useSidebarState({ storageKey: "k", defaultOpen: true }));
    expect(first.result.current.isDesktop).toBe(true);
    expect(first.result.current.open).toBe(true);
    expect(first.result.current.overlayActive).toBe(false);

    act(() => first.result.current.toggle());
    expect(first.result.current.open).toBe(false);
    expect(window.localStorage.getItem("k")).toBe("false");

    first.unmount();
    const second = renderHook(() => useSidebarState({ storageKey: "k", defaultOpen: true }));
    expect(second.result.current.isDesktop).toBe(true);
    expect(second.result.current.open).toBe(false);
  });

  it("starts closed on mobile and toggles the ephemeral flag", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useSidebarState({ storageKey: "k", defaultOpen: true }));
    expect(result.current.isDesktop).toBe(false);
    expect(result.current.open).toBe(false);
    expect(result.current.overlayActive).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    expect(result.current.overlayActive).toBe(true);
  });

  it("reacts to live breakpoint changes in both directions", () => {
    const media = mockMatchMedia(true);
    const { result } = renderHook(() => useSidebarState({ storageKey: "k", defaultOpen: true }));
    expect(result.current.open).toBe(true);
    expect(result.current.overlayActive).toBe(false);

    act(() => media.set(false));
    expect(result.current.isDesktop).toBe(false);
    expect(result.current.open).toBe(false);

    act(() => result.current.toggle());
    expect(result.current.overlayActive).toBe(true);

    act(() => media.set(true));
    expect(result.current.isDesktop).toBe(true);
    expect(result.current.open).toBe(true);
    expect(result.current.overlayActive).toBe(false);
  });

  it("closes the mobile overlay when re-entering mobile", () => {
    const media = mockMatchMedia(false);
    const { result } = renderHook(() => useSidebarState({ storageKey: "k", defaultOpen: true }));
    act(() => result.current.toggle());
    expect(result.current.overlayActive).toBe(true);

    act(() => media.set(true));
    act(() => media.set(false));
    expect(result.current.overlayActive).toBe(false);
  });
});
