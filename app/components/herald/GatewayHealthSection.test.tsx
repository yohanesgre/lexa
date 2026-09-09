// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GatewayHealthSection } from "./GatewayHealthSection";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const providers = {
  data: [
    { id: "p1", label: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", hasKey: true, keyMask: null, models: [] },
    { id: "p2", label: "Fallback", baseUrl: "https://example.com/v1", hasKey: true, keyMask: null, models: [] },
  ],
};

const healthP1 = { providerId: "p1", circuitState: "closed", failureCount: 0, openedAt: null, lastProbeAt: null, consecutiveFailures: 0 };
const healthP2 = { providerId: "p2", circuitState: "open", failureCount: 5, openedAt: "2026-08-26T18:04:02Z", lastProbeAt: "2026-08-26T18:10:11Z", consecutiveFailures: 5 };

function routeFetch(impl: (url: string) => unknown) {
  return vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => impl(url) }));
}

describe("GatewayHealthSection", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders one live row per provider with worst state in header", async () => {
    vi.stubGlobal("fetch", routeFetch((url) =>
      url.endsWith("/health") ? (url.includes("p1") ? healthP1 : healthP2) : providers
    ));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getByText("Fallback")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("2026-08-26T18:04:02Z")).toBeTruthy();
    const badges = screen.getAllByText("open");
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it("prefers half-open over closed in header", async () => {
    const half = { ...healthP1, circuitState: "half-open" };
    vi.stubGlobal("fetch", routeFetch((url) =>
      url.endsWith("/health") ? (url.includes("p1") ? half : healthP1) : providers
    ));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getAllByText("half-open").length).toBeGreaterThanOrEqual(2);
  });

  it("shows checking until health settles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health")) return new Promise(() => {});
      return Promise.resolve({ ok: true, json: async () => providers });
    }));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getByText("checking…")).toBeTruthy();
  });

  it("shows error plus Retry that refetches providers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "boom" } }) })
      .mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => (url.endsWith("/health") ? healthP1 : providers) }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await screen.findByText("Failed to load providers");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows empty sentence with no providers", async () => {
    vi.stubGlobal("fetch", routeFetch(() => ({ data: [] })));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("No providers configured.")).toBeTruthy());
  });

  it("marks failed provider row error while others render", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/health") && url.includes("p2")) {
        return Promise.resolve({ ok: false, json: async () => ({ error: { message: "down" } }) });
      }
      return Promise.resolve({ ok: true, json: async () => (url.endsWith("/health") ? healthP1 : providers) });
    }));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("error")).toBeTruthy());
    expect(screen.getByText("Opencode Go")).toBeTruthy();
  });
});
