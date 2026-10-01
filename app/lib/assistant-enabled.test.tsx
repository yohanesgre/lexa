// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ADR-0003 §F.3 — `useAssistantEnabled` is the single capability gate the UI
// reads. `enabled` is strictly true only once `GET /api/capabilities` resolves
// with `assistant:true`; the in-flight and disabled flavors stay gated.

const h = vi.hoisted(() => ({
  data: undefined as { assistant?: boolean; flavor?: "bun" | "workers" } | undefined,
  isLoading: false,
  lastOptions: undefined as { enabled?: boolean } | undefined,
}));

vi.mock("./queries", () => ({
  useCapabilities: (opts?: { enabled?: boolean }) => {
    h.lastOptions = opts;
    return { data: h.data, isLoading: h.isLoading };
  },
}));

import { useAssistantEnabled } from "./assistant-enabled";

beforeEach(() => {
  h.data = undefined;
  h.isLoading = false;
  h.lastOptions = undefined;
});

describe("useAssistantEnabled", () => {
  it("is enabled on the Workers flavor", () => {
    h.data = { assistant: true, flavor: "workers" };
    const { result } = renderHook(() => useAssistantEnabled());
    expect(result.current).toEqual({ enabled: true, loading: false, flavor: "workers" });
  });

  it("is disabled on the Bun flavor", () => {
    h.data = { assistant: false, flavor: "bun" };
    const { result } = renderHook(() => useAssistantEnabled());
    expect(result.current).toEqual({ enabled: false, loading: false, flavor: "bun" });
  });

  it("stays gated while the capabilities read is in flight", () => {
    h.isLoading = true;
    const { result } = renderHook(() => useAssistantEnabled());
    expect(result.current).toEqual({ enabled: false, loading: true, flavor: undefined });
  });

  it("stays gated when the read has not resolved", () => {
    const { result } = renderHook(() => useAssistantEnabled());
    expect(result.current.enabled).toBe(false);
  });

  it("forwards the enabled option to suppress the read on bare pages", () => {
    renderHook(() => useAssistantEnabled({ enabled: false }));
    expect(h.lastOptions).toEqual({ enabled: false });
  });
});
