// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper, createTestQueryClient } from "../../test-utils";
import { GatewayHealthSection } from "./GatewayHealthSection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

const wrapper = () => createQueryWrapper(createTestQueryClient(), { toast: true });

const providers = {
  data: [
    {
      id: "p1", label: "Opencode Go", baseUrl: "https://opencode.ai/zen/go/v1", hasKey: true, keyMask: null,
      models: [
        { modelId: "openai/gpt-5.1", enabled: true },
        { modelId: "anthropic/claude-sonnet-4.5", enabled: true },
        { modelId: "meta/llama", enabled: false },
      ],
    },
    { id: "p2", label: "Fallback", baseUrl: "https://openrouter.ai/api/v1", hasKey: true, keyMask: null, models: [] },
  ],
};

const healthP1 = {
  providerId: "p1", circuitState: "closed", failureCount: 0, consecutiveFailures: 0, openedAt: null,
  lastProbeAt: "2026-08-27 14:22:11", latencyMs: 120, retryAfterSeconds: null, lastFailureCode: null, lastFailureAt: null,
  lastCheckedAt: "2026-08-27 14:22:11",
};
const healthP2 = {
  providerId: "p2", circuitState: "open", failureCount: 5, consecutiveFailures: 5, openedAt: "2026-08-26 18:04:02",
  lastProbeAt: "2026-08-26 18:10:11", latencyMs: null, retryAfterSeconds: 240, lastFailureCode: "PROVIDER_UNREACHABLE",
  lastFailureAt: "2026-08-26 18:10:11", lastCheckedAt: "2026-08-26 18:10:11",
};

function routeFetch(impl: (url: string) => unknown) {
  return vi.fn().mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => impl(url) }));
}

function twoProviderFetch() {
  return routeFetch((url) =>
    url.endsWith("/health") ? (url.includes("p1") ? healthP1 : healthP2) : providers
  );
}

describe("GatewayHealthSection (redesigned)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders one row per provider with plain-language statuses and the aggregate line", async () => {
    vi.stubGlobal("fetch", twoProviderFetch());
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getByText("Fallback")).toBeTruthy();
    expect(screen.getAllByText("Working").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Offline").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1 provider offline")).toBeTruthy();
    expect(screen.getByText(/2 providers · 1 working · 1 offline/)).toBeTruthy();
    expect(screen.getByText("Serving 2 models · gpt-5.1 · claude-sonnet-4.5")).toBeTruthy();
    expect(screen.getByText("No models enabled")).toBeTruthy();
  });

  it("shows the status legend", async () => {
    vi.stubGlobal("fetch", twoProviderFetch());
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getAllByText("Having trouble").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Not checked yet").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Slow").length).toBeGreaterThanOrEqual(1);
  });

  it("puts circuit jargon inside the native Details disclosure", async () => {
    vi.stubGlobal("fetch", twoProviderFetch());
    const user = userEvent.setup();
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    const summaries = screen.getAllByText("Details");
    await user.click(summaries[1]!);
    expect(screen.getAllByText("open").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/PROVIDER_UNREACHABLE/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("https://openrouter.ai/api/v1")).toBeTruthy();
  });

  it("renders Not checked yet when no check has been recorded", async () => {
    const never = { ...healthP1, lastProbeAt: null, lastCheckedAt: null };
    vi.stubGlobal("fetch", routeFetch((url) => (url.endsWith("/health") ? (url.includes("p1") ? never : healthP2) : { data: [providers.data[0], providers.data[1]] })));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getAllByText("Not checked yet").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/No checks recorded yet/)).toBeTruthy();
  });

  it("renders Slow when the last response is above the watch threshold", async () => {
    const slow = { ...healthP1, latencyMs: 6000 };
    vi.stubGlobal("fetch", routeFetch((url) => (url.endsWith("/health") ? (url.includes("p1") ? slow : healthP1) : { data: [providers.data[0]] })));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Opencode Go")).toBeTruthy());
    expect(screen.getAllByText("Slow").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Responded in 6,000 ms/)).toBeTruthy();
  });

  it("Test connection POSTs the probe and updates the row from the response", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/probe")) {
        return Promise.resolve({ ok: true, json: async () => ({ ...healthP2, circuitState: "closed", failureCount: 0, consecutiveFailures: 0, retryAfterSeconds: null }) });
      }
      return Promise.resolve({ ok: true, json: async () => (url.endsWith("/health") ? (url.includes("p1") ? healthP1 : healthP2) : providers) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Fallback")).toBeTruthy());
    const testButtons = screen.getAllByRole("button", { name: "Test connection" });
    await user.click(testButtons[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/p2/probe"), expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByText("All systems working")).toBeTruthy());
  });

  it("shows an inline danger notice when the probe fails", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/probe")) {
        return Promise.resolve({ ok: false, json: async () => ({ error: { code: "PROVIDER_UNREACHABLE", message: "upstream refused" } }) });
      }
      return Promise.resolve({ ok: true, json: async () => (url.endsWith("/health") ? (url.includes("p1") ? healthP1 : healthP2) : providers) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("Fallback")).toBeTruthy());
    await user.click(screen.getAllByRole("button", { name: "Test connection" })[1]!);
    await waitFor(() => expect(screen.getByText("upstream refused")).toBeTruthy());
  });

  it("renders an empty box with no providers", async () => {
    vi.stubGlobal("fetch", routeFetch(() => ({ data: [] })));
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByText("No providers configured")).toBeTruthy());
  });

  it("renders the providers load error with Retry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "boom" } }) })
      .mockImplementation((url: string) => Promise.resolve({ ok: true, json: async () => (url.endsWith("/health") ? healthP1 : providers) }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<GatewayHealthSection />, { wrapper: wrapper() });
    await screen.findByText("Couldn't load providers.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
