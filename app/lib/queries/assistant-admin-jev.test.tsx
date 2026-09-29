// @vitest-environment jsdom
// Invariant #6: Jev mutation responses are authoritative — the cache is updated
// via setQueryData from the response, never via invalidateQueries (no refetch
// on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../../components/ui/Toast";
import {
  useAssistantJevConfig,
  useUpdateAssistantJevConfig,
  useProjectJev,
  useSetProjectJev,
} from "./assistant-admin";
import type { AssistantJevConfig } from "../api";
import type { AssistantJevProjectPublic } from "../../../shared/assistant";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    return Promise.resolve(json(hit));
  });
}

const CONFIG: AssistantJevConfig = {
  config: { id: "default", baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, hasKey: false, keyMask: null, createdAt: "t", updatedAt: "t" },
  secretsEnabled: true,
};
const SAVED: AssistantJevConfig = {
  config: { ...CONFIG.config, enabled: true, hasKey: true, keyMask: "jev-…4f2a" },
  secretsEnabled: true,
};
const PROJECT_ROW: AssistantJevProjectPublic = { projectId: "p1", enabled: true, available: true, createdAt: "t", updatedAt: "t" };

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function getCalls(url: string): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]) === url && ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length;
}

function bodyOf(url: string): unknown {
  const calls = fetchMock.mock.calls.filter((c) => String(c[0]) === url && (c[1] as RequestInit | undefined)?.method !== "GET");
  const call = calls[calls.length - 1];
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

describe("Jev config mutations — cache from the authoritative response", () => {
  it("useUpdateAssistantJevConfig writes the response body to the cache — no refetch", async () => {
    routes.set("PATCH /api/assistant/jev", SAVED);
    queryClient.setQueryData(["assistant-jev"], CONFIG);
    const before = getCalls("/api/assistant/jev");

    const { result } = renderHook(() => ({ cfg: useAssistantJevConfig(), upd: useUpdateAssistantJevConfig() }), { wrapper });
    await act(async () => { await result.current.upd.mutateAsync({ enabled: true }); });

    expect(queryClient.getQueryData<AssistantJevConfig>(["assistant-jev"])).toEqual(SAVED);
    expect(getCalls("/api/assistant/jev")).toBe(before);
  });

  it("sends only the changed fields plus `secret` when non-empty, and `clearSecret` for a clear", async () => {
    routes.set("PATCH /api/assistant/jev", SAVED);
    queryClient.setQueryData(["assistant-jev"], CONFIG);

    const { result } = renderHook(() => useUpdateAssistantJevConfig(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: true, secret: "jev_abc" }); });
    expect(bodyOf("/api/assistant/jev")).toEqual({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: true, secret: "jev_abc" });

    await act(async () => { await result.current.mutateAsync({ clearSecret: true }); });
    const body = bodyOf("/api/assistant/jev") as Record<string, unknown>;
    expect(body).toEqual({ clearSecret: true });
    expect(body).not.toHaveProperty("secret");
  });

  it("the GET hook reads the whole body so the capability can never disagree with the config", async () => {
    routes.set("GET /api/assistant/jev", SAVED);
    const { result } = renderHook(() => useAssistantJevConfig(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(SAVED));
    expect(result.current.data?.secretsEnabled).toBe(true);
  });
});

describe("Project Jev mutations — cache from the authoritative response", () => {
  it("useSetProjectJev replaces the project cache from the response — no refetch", async () => {
    routes.set("PUT /api/projects/p1/assistant/jev", PROJECT_ROW);
    queryClient.setQueryData(["project-jev", "p1"], { ...PROJECT_ROW, enabled: false });
    const before = getCalls("/api/projects/p1/assistant/jev");

    const { result } = renderHook(() => ({ proj: useProjectJev("p1"), set: useSetProjectJev("p1") }), { wrapper });
    await act(async () => { await result.current.set.mutateAsync({ enabled: true }); });

    expect(bodyOf("/api/projects/p1/assistant/jev")).toEqual({ enabled: true });
    expect(queryClient.getQueryData<AssistantJevProjectPublic>(["project-jev", "p1"])).toEqual(PROJECT_ROW);
    expect(getCalls("/api/projects/p1/assistant/jev")).toBe(before);
  });

  it("useProjectJev exposes the additive `available` flag", async () => {
    routes.set("GET /api/projects/p1/assistant/jev", { ...PROJECT_ROW, available: false, enabled: false });
    const { result } = renderHook(() => useProjectJev("p1"), { wrapper });
    await waitFor(() => expect(result.current.data?.available).toBe(false));
  });
});
