// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RuntimeSetupModal } from "./RuntimeSetupModal";
import type { Machine } from "../../../shared/types";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A machine whose lastSeen is now → isMachineListening() true (2 min window).
function listeningMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1",
    hostname: "box1",
    clis: [{ provider: "opencode", version: "1.2.3" }],
    lastSeen: new Date().toISOString(),
    createdAt: "t",
    ...overrides,
  } as unknown as Machine;
}

const OFFLINE_MACHINE: Machine = { id: "m2", hostname: "box2", clis: [], lastSeen: "2020-01-01T00:00:00.000Z", createdAt: "t" } as unknown as Machine;

const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
    if (hit === "HTTP_500") return Promise.resolve(new Response("boom", { status: 500 }));
    return Promise.resolve(json(hit));
  });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/hearth/machines", { data: [listeningMachine(), OFFLINE_MACHINE] });
  routes.set("GET /api/hearth/runtimes", { data: [] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("RuntimeSetupModal", () => {
  it("renders the machine list with listening/offline states", async () => {
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });
    expect(await screen.findByText("box1")).toBeInTheDocument();
    expect(screen.getByText("box2")).toBeInTheDocument();
    // offline machine's row is disabled
    expect(screen.getByText("box2").closest("button")).toBeDisabled();
    expect(screen.getByText(/Offline · last seen/)).toBeInTheDocument();
  });
  it("shows the no-machines notice when none are registered", async () => {
    routes.set("GET /api/hearth/machines", { data: [] });
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });
    expect(await screen.findByText(/No machines registered/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
