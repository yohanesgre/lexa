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

  it("creates a machine login key on step 0 — raw key shown once with Copy", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/settings/api-keys", {
      key: { id: "k2", name: "lexa-machine", createdAt: "t", lastUsedAt: null },
      rawKey: "lxk_machine123",
    });
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });
    expect(await screen.findByText("box1")).toBeInTheDocument();
    expect(screen.getByText("Create an API key for this machine")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Key name"), "lexa-machine");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("lxk_machine123")).toBeInTheDocument();
    // copyToClipboard succeeds in jsdom, so the auto-copy on create flips the
    // label to "Copied" immediately
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByText("Raw key is held in memory and will not be shown again.")).toBeInTheDocument();
    expect(screen.getByText(/Use the created key in/)).toBeInTheDocument();
  });

  it("the machine login key does not enable the step-2 Send gate", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/settings/api-keys", {
      key: { id: "k2", name: "lexa-machine", createdAt: "t", lastUsedAt: null },
      rawKey: "lxk_machine123",
    });
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });

    // step 0: pick the machine and create the machine login key
    const row = (await screen.findByText("box1")).closest("button")!;
    await user.click(row);
    await user.type(screen.getByLabelText("Key name"), "lexa-machine");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("lxk_machine123");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 1: agent CLI
    await user.click(screen.getByRole("button", { name: /opencode/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 2: Send stays disabled — no runtime key was created (separate state)
    expect(screen.getByText("Create key and install")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send install event/ })).toBeDisabled();
  });

  it("walks the full setup flow: machine → agent CLI → key → send install event", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/settings/api-keys", {
      key: { id: "k1", name: "hearth-opencode", createdAt: "t", lastUsedAt: null },
      rawKey: "lxk_secret123",
    });
    routes.set("POST /api/hearth/runtime-events", { id: "ev1" });
    routes.set("GET /api/hearth/runtime-events/ev1", { id: "ev1", status: "completed" });
    routes.set("GET /api/hearth/runtimes", { data: [{ id: "r1", machineId: "m1", provider: "opencode", status: "online" }] });
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });

    // step 0: choose the listening machine
    const row = (await screen.findByText("box1")).closest("button")!;
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 1: agent CLI
    expect(screen.getByText("Choose the agent CLI")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /opencode/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // step 2: create a fresh key
    expect(screen.getByText("Create key and install")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Key name"), "hearth-opencode");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("lxk_secret123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send install event/ })).toBeEnabled();

    // step 3: send the install event
    await user.click(screen.getByRole("button", { name: /Send install event/ }));
    expect(await screen.findByText("Runtime is online")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    // exactly one POST to runtime-events, no refetch loops beyond the expected poll
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/runtime-events") && (c[1] as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0]![1] as RequestInit).body as string)).toEqual({
      machineId: "m1",
      action: "install",
      agentCli: "opencode",
      apiKeyId: "k1",
      rawKey: "lxk_secret123",
    });
  });

  it("surfaces a send failure in the step-2 error notice", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/settings/api-keys", {
      key: { id: "k1", name: "k", createdAt: "t", lastUsedAt: null },
      rawKey: "lxk_secret123",
    });
    routes.set("POST /api/hearth/runtime-events", "HTTP_500");
    render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });

    const row = (await screen.findByText("box1")).closest("button")!;
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /opencode/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText("Key name"), "k");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("lxk_secret123");
    await user.click(screen.getByRole("button", { name: /Send install event/ }));

    // api.request throws Error(`HTTP ${status}`) for non-JSON error bodies
    expect(await screen.findByText("HTTP 500")).toBeInTheDocument();
    // still on step 2
    expect(screen.getByText("Create key and install")).toBeInTheDocument();
  });

  it("closes via the overlay and the header X", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<RuntimeSetupModal onClose={onClose} />, { wrapper });
    await screen.findByText("box1");
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    await user.click(closeButtons[0]!); // overlay
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(closeButtons[1]!); // header X
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
