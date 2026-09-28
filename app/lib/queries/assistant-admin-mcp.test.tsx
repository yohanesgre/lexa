// @vitest-environment jsdom
// Invariant #6: MCP mutation responses are authoritative — the cache is updated
// via setQueryData from the response, never via invalidateQueries (no refetch
// on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../../components/ui/Toast";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useUpdateMcpServer,
  useSetProjectMcpServers,
} from "./assistant-admin";
import type { McpProjectServer, McpServer } from "../api";

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
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(hit));
  });
}

const SENTRY: McpServer = {
  id: "sentry", label: "Sentry", transportType: "sse", url: "https://mcp.sentry.example/sse", command: null,
  args: [], hasSecret: false, enabled: false, createdAt: "t", updatedAt: "t",
};
const LINEAR: McpServer = {
  id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", command: null,
  args: [], hasSecret: true, enabled: true, createdAt: "t", updatedAt: "t",
};
const PROJECT_ROW: McpProjectServer = { projectId: "p1", serverId: "linear", enabled: true, createdAt: "t", updatedAt: "t" };

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

describe("MCP server mutations — cache from the authoritative response", () => {
  it("useCreateMcpServer appends the response to the cache — no refetch", async () => {
    routes.set("POST /api/assistant/mcp-servers", LINEAR);
    queryClient.setQueryData(["assistant-mcp-servers"], [SENTRY]);
    const before = getCalls("/api/assistant/mcp-servers");
    const { result } = renderHook(() => useCreateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ label: "Linear", transportType: "http", url: LINEAR.url! }); });
    expect(queryClient.getQueryData<McpServer[]>(["assistant-mcp-servers"])).toEqual([SENTRY, LINEAR]);
    expect(getCalls("/api/assistant/mcp-servers")).toBe(before);
  });

  it("useUpdateMcpServer replaces the matching row in place", async () => {
    routes.set("PATCH /api/assistant/mcp-servers/sentry", { ...SENTRY, enabled: true });
    queryClient.setQueryData(["assistant-mcp-servers"], [SENTRY, LINEAR]);
    const { result } = renderHook(() => useUpdateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "sentry", enabled: true }); });
    const next = queryClient.getQueryData<McpServer[]>(["assistant-mcp-servers"])!;
    expect(next[0]).toMatchObject({ id: "sentry", enabled: true });
    expect(next[1]).toMatchObject({ id: "linear" });
  });

  it("useDeleteMcpServer filters the row", async () => {
    routes.set("DELETE /api/assistant/mcp-servers/linear", 204);
    queryClient.setQueryData(["assistant-mcp-servers"], [SENTRY, LINEAR]);
    const { result } = renderHook(() => useDeleteMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync("linear"); });
    expect(queryClient.getQueryData<McpServer[]>(["assistant-mcp-servers"])).toEqual([SENTRY]);
  });

  it("useSetProjectMcpServers replaces the project cache from the response — no refetch", async () => {
    routes.set("PUT /api/projects/p1/assistant/mcp-servers", { data: [PROJECT_ROW] });
    queryClient.setQueryData(["project-mcp-servers", "p1"], []);
    const before = getCalls("/api/projects/p1/assistant/mcp-servers");
    const { result } = renderHook(() => useSetProjectMcpServers("p1"), { wrapper });
    await act(async () => { await result.current.mutateAsync([{ serverId: "linear", enabled: true }]); });
    expect(queryClient.getQueryData<McpProjectServer[]>(["project-mcp-servers", "p1"])).toEqual([PROJECT_ROW]);
    expect(getCalls("/api/projects/p1/assistant/mcp-servers")).toBe(before);
  });
});
