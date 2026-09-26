// @vitest-environment jsdom
// Wireframe settings-workspace.html: the Machines / Agent Runtimes sections are
// gone (agent-runtime tier removed); the rate-limit copy names both /api and /mcp.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";

const h = vi.hoisted(() => ({
  state: {
    rateLimit: undefined as unknown,
  },
}));

vi.mock("../../lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/queries")>();
  return {
    ...actual,
    useRateLimit: () => ({ data: h.state.rateLimit, isLoading: false, isError: false }),
  };
});

vi.mock("../../lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { ApiKeyRevealModal, RateLimitSection } from "./SettingsSections";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
  );
}

beforeEach(() => {
  h.state.rateLimit = undefined;
});

describe("RateLimitSection", () => {
  it("names the /api surface in the description", () => {
    h.state.rateLimit = { max: 6000, windowMs: 600000, envOverride: false };
    render(<RateLimitSection />, { wrapper: wrapper() });
    expect(screen.getByText(/Applies to \/api;/)).toBeInTheDocument();
  });
});

describe("ApiKeyRevealModal", () => {
  it("makes the revealed key selectable as a manual-copy fallback", () => {
    const { container } = render(<ApiKeyRevealModal name="Hermes Staging" fullKey="lxk_abc123" onDone={vi.fn()} />, { wrapper: wrapper() });
    const code = container.querySelector("code") as HTMLElement;
    expect(code).toHaveTextContent("lxk_abc123");
    expect(code.style.userSelect).toBe("all");
  });
});
