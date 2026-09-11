// @vitest-environment jsdom
// Wireframe settings-runtime-restart.html: offline modal shows the systemd
// alternative and a persistent "Waiting for the runtime child to come back…"
// status row.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../ui/Toast";
import * as api from "../../lib/api";
import type { Machine, Runtime } from "../../../shared/types";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    listRuntimes: vi.fn(),
    listMachines: vi.fn(),
    getRuntimeEvent: vi.fn(),
  };
});

import { RuntimeRestartModal } from "./RuntimeRestartModal";

const RUNTIME = {
  id: "r1", name: "staging-box", provider: "command-code", machineId: "m1",
  agent: "", model: "", printLogs: false, logLevel: "", extraArgs: [],
  modelsCatalog: [], agentsCatalog: [], status: "offline", lastError: null,
  hostname: "box01", lastSeen: null, createdAt: "2026-01-01T00:00:00Z",
} as Runtime;

const MACHINE: Machine = {
  id: "m1", hostname: "box01", lastSeen: null, clis: [], createdAt: "2026-01-01T00:00:00Z",
};

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(api.listRuntimes).mockReset().mockResolvedValue({ data: [RUNTIME] });
  vi.mocked(api.listMachines).mockReset().mockResolvedValue({ data: [MACHINE] });
  vi.mocked(api.getRuntimeEvent).mockReset();
});

describe("RuntimeRestartModal", () => {
  it("shows the systemd alternative and the persistent waiting row for an offline machine", async () => {
    render(<RuntimeRestartModal runtime={RUNTIME} onClose={() => {}} />, { wrapper: wrapper() });

    expect(await screen.findByText("Or via systemd")).toBeInTheDocument();
    expect(screen.getByText("Listener command")).toBeInTheDocument();
    expect(screen.getByText(/systemctl --user restart lexa-hearth-listen/)).toBeInTheDocument();
    expect(screen.getByText(/journalctl --user -u lexa-hearth-listen/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the runtime child to come back/)).toBeInTheDocument();
  });
});
