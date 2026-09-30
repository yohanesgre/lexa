import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import type { Board } from "../shared/types";
import { ToastProvider } from "./components/ui/Toast";
import { TeamSelectionProvider } from "./lib/team-selection";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function createQueryWrapper(
  client: QueryClient,
  options: { toast?: boolean; teamSelection?: boolean } = {}
): ComponentType<{ children: ReactNode }> {
  return function QueryWrapper({ children }: { children: ReactNode }): ReactElement {
    const withToast = options.toast ? <ToastProvider>{children}</ToastProvider> : children;
    const body = options.teamSelection ? <TeamSelectionProvider>{withToast}</TeamSelectionProvider> : withToast;
    return <QueryClientProvider client={client}>{body}</QueryClientProvider>;
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function createFetchMock(): {
  fetchMock: ReturnType<typeof vi.fn>;
  routes: Map<string, unknown>;
  mockFetch: () => void;
} {
  const fetchMock = vi.fn();
  const routes = new Map<string, unknown>();
  const mockFetch = (): void => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = `${init?.method ?? "GET"} ${url}`;
      const hit = routes.get(key) ?? routes.get(`GET ${url}`);
      if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
      if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json(hit));
    });
  };
  return { fetchMock, routes, mockFetch };
}

export function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    project: {
      id: "p1",
      name: "Demo",
      slug: "demo",
      key: "DEMO",
      description: "",
      repos: [],
      createdAt: "t",
      updatedAt: "t",
    },
    columns: [],
    swimlanes: [],
    milestones: [],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [],
    ...overrides,
  };
}

export class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  readonly callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

export function stubMatchMedia(matches: boolean | ((query: string) => boolean)): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: typeof matches === "function" ? matches(query) : matches,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }))
  );
}

export function controllableMatchMedia(options: { mobile: boolean; reducedMotion?: boolean }): { toDesktop(): void } {
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

export function mockMatchMedia(initial: boolean): { set(next: boolean): void } {
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
