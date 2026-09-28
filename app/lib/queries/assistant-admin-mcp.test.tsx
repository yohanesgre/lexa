// @vitest-environment jsdom
// Invariant #6: MCP mutation responses are authoritative — the cache is updated
// via setQueryData from the response, never via invalidateQueries (no refetch
// on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../../components/ui/Toast";
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpManagedSecrets,
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
  args: [], hasSecret: false, secretSource: "none", enabled: false, createdAt: "t", updatedAt: "t",
};
const LINEAR: McpServer = {
  id: "linear", label: "Linear", transportType: "http", url: "https://mcp.linear.example/mcp", command: null,
  args: [], hasSecret: true, secretSource: "reference", enabled: true, createdAt: "t", updatedAt: "t",
};
const PROJECT_ROW: McpProjectServer = { projectId: "p1", serverId: "linear", enabled: true, createdAt: "t", updatedAt: "t" };

// The registry cache holds the whole list BODY, not just the rows: the body also
// carries `managedSecretsEnabled` (the server's real capability), so the flag
// can never disagree with the rows it describes.
type McpList = { data: McpServer[]; managedSecretsEnabled: boolean | undefined };
function seedCache(data: McpServer[], managedSecretsEnabled = true): void {
  queryClient.setQueryData(["assistant-mcp-servers"], { data, managedSecretsEnabled } satisfies McpList);
}
function cachedList(): McpList {
  return queryClient.getQueryData<McpList>(["assistant-mcp-servers"])!;
}

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
    seedCache([SENTRY]);
    const before = getCalls("/api/assistant/mcp-servers");
    const { result } = renderHook(() => useCreateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ label: "Linear", transportType: "http", url: LINEAR.url! }); });
    expect(cachedList()).toEqual({ data: [SENTRY, LINEAR], managedSecretsEnabled: true });
    expect(getCalls("/api/assistant/mcp-servers")).toBe(before);
  });

  it("useUpdateMcpServer replaces the matching row in place", async () => {
    routes.set("PATCH /api/assistant/mcp-servers/sentry", { ...SENTRY, enabled: true });
    seedCache([SENTRY, LINEAR]);
    const { result } = renderHook(() => useUpdateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "sentry", enabled: true }); });
    const next = cachedList();
    expect(next.data[0]).toMatchObject({ id: "sentry", enabled: true });
    expect(next.data[1]).toMatchObject({ id: "linear" });
    expect(next.managedSecretsEnabled).toBe(true);
  });

  it("useDeleteMcpServer filters the row", async () => {
    routes.set("DELETE /api/assistant/mcp-servers/linear", 204);
    seedCache([SENTRY, LINEAR]);
    const { result } = renderHook(() => useDeleteMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync("linear"); });
    expect(cachedList()).toEqual({ data: [SENTRY], managedSecretsEnabled: true });
  });

  it("a mutation never invents the capability — a cold cache leaves it unknown", async () => {
    routes.set("POST /api/assistant/mcp-servers", LINEAR);
    const { result } = renderHook(() => useCreateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ label: "Linear", transportType: "http", url: LINEAR.url! }); });
    // undefined, not false: nothing has said the key is absent, and a seeded
    // false would render as the definitive "managed tokens are off" warning.
    expect(cachedList()).toEqual({ data: [LINEAR], managedSecretsEnabled: undefined });
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

describe("useMcpManagedSecrets — unknown until the server says otherwise", () => {
  const LIST = "/api/assistant/mcp-servers";

  it("is undefined while the list GET is unanswered, never false", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useMcpManagedSecrets(), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(result.current.data).not.toBe(false);
  });

  it("is undefined after a 500 (retry off), never false", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "boom" } }, 500));
    const { result } = renderHook(() => useMcpManagedSecrets(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.data).not.toBe(false);
  });

  it("is undefined off a cold-cache mutation entry, not a fabricated false", async () => {
    // The only shape that actually runs `select` with the field missing: a
    // mutation wrote the list body while the capability was still unknown, and
    // the GET is still unanswered. `?? false` here would render as the
    // definitive "managed tokens are off" warning.
    routes.set("POST /api/assistant/mcp-servers", LINEAR);
    const post = renderHook(() => useCreateMcpServer(), { wrapper });
    await act(async () => { await post.result.current.mutateAsync({ label: "Linear", transportType: "http", url: LINEAR.url! }); });

    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useMcpManagedSecrets(), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(result.current.data).not.toBe(false);
  });

  it("mirrors the server true once the body resolves", async () => {
    routes.set(`GET ${LIST}`, { data: [SENTRY], managedSecretsEnabled: true });
    const { result } = renderHook(() => useMcpManagedSecrets(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(true));
  });

  it("mirrors the server false once the body resolves", async () => {
    routes.set(`GET ${LIST}`, { data: [SENTRY], managedSecretsEnabled: false });
    const { result } = renderHook(() => useMcpManagedSecrets(), { wrapper });
    await waitFor(() => expect(result.current.data).toBe(false));
  });
});

describe("MCP managed secret — write-only on the wire", () => {
  function bodyOf(url: string): unknown {
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === url && (c[1] as RequestInit | undefined)?.method !== "GET");
    return JSON.parse(String((call?.[1] as RequestInit).body));
  }

  const TOKEN = "lin_api_3f9c1d7b2e";

  it("sends the managed token as `secret` and reads back only secretSource", async () => {
    routes.set("POST /api/assistant/mcp-servers", { ...LINEAR, hasSecret: true, secretSource: "managed" });
    seedCache([]);
    const { result } = renderHook(() => useCreateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ label: "Linear", transportType: "http", url: LINEAR.url!, secret: TOKEN }); });

    expect(bodyOf("/api/assistant/mcp-servers")).toEqual({ label: "Linear", transportType: "http", url: LINEAR.url, secret: TOKEN });
    const cached = cachedList();
    expect(cached.data[0]).toMatchObject({ hasSecret: true, secretSource: "managed" });
    // The response is authoritative and carries no value — the cache never holds one.
    expect(JSON.stringify(cached)).not.toContain(TOKEN);
    expect(cached.data[0]).not.toHaveProperty("secret");
  });

  it("clearSecret: true is the only removal route — no secretRef: null is ever sent", async () => {
    routes.set("PATCH /api/assistant/mcp-servers/linear", { ...LINEAR, hasSecret: false, secretSource: "none" });
    seedCache([LINEAR]);
    const { result } = renderHook(() => useUpdateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "linear", clearSecret: true }); });

    const body = bodyOf("/api/assistant/mcp-servers/linear");
    expect(body).toEqual({ clearSecret: true });
    expect(body).not.toHaveProperty("secretRef");
    expect(cachedList().data[0]).toMatchObject({ hasSecret: false, secretSource: "none" });
  });

  it("an empty secret value is never sent as a clear — the PATCH carries no removal at all", async () => {
    routes.set("PATCH /api/assistant/mcp-servers/linear", LINEAR);
    seedCache([LINEAR]);
    const { result } = renderHook(() => useUpdateMcpServer(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "linear", secret: "", secretRef: "" }); });

    // Blank values mean KEEP server-side (blankSecret/blankReference → null),
    // so the one thing that must never appear here is `clearSecret`.
    const body = bodyOf("/api/assistant/mcp-servers/linear") as Record<string, unknown>;
    expect(body).not.toHaveProperty("clearSecret");
    expect(cachedList().data[0]).toMatchObject({ hasSecret: true, secretSource: "reference" });
  });
});
