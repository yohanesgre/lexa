// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ToastProvider } from "../ui/Toast";
import type { Machine } from "../../../shared/types";

const role = vi.hoisted(() => ({
  isSuperadmin: true,
  teams: [{ id: "t1", name: "Team One", slug: "team-one", createdAt: "t" }],
}));

const api = vi.hoisted(() => ({
  listMachines: vi.fn(),
  getRuntimeEvent: vi.fn(),
  listRuntimes: vi.fn(),
  createRuntimeEvent: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  listMachines: api.listMachines,
  getRuntimeEvent: api.getRuntimeEvent,
  listRuntimes: api.listRuntimes,
  createRuntimeEvent: api.createRuntimeEvent,
}));

vi.mock("../../lib/useHearthRole", () => ({ useHearthRole: () => role }));

vi.mock("../../lib/queries", () => ({
  useCreateApiKey: () => ({
    mutate: (_name: string, opts: { onSuccess: (r: { rawKey: string; key: { id: string } }) => void }) =>
      opts.onSuccess({ rawKey: "lxk_raw", key: { id: "k1" } }),
    isPending: false,
  }),
}));

vi.mock("../../lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => {}) }));

import { RuntimeSetupModal } from "./RuntimeSetupModal";

const MACHINE: Machine = {
  id: "m1",
  hostname: "host",
  clis: [],
  lastSeen: new Date().toISOString(),
  createdAt: "2026-01-01T00:00:00.000Z",
};

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  role.isSuperadmin = true;
  role.teams = [{ id: "t1", name: "Team One", slug: "team-one", createdAt: "t" }];
  api.listMachines.mockReset().mockResolvedValue({ data: [MACHINE] });
  api.getRuntimeEvent.mockReset().mockResolvedValue({ id: "e1", status: "pending", teamId: null });
  api.listRuntimes.mockReset().mockResolvedValue({ data: [] });
  api.createRuntimeEvent.mockReset().mockImplementation((input: unknown) => Promise.resolve({ id: "evt1", status: "pending", ...(input as object) }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  queryClient.clear();
});

async function renderModal() {
  render(<RuntimeSetupModal onClose={() => {}} />, { wrapper });
  await screen.findByText("m1");
}

async function driveToSend() {
  fireEvent.click(screen.getByRole("button", { name: /m1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: /opencode/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Key name");
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "runtime-key" } });
  fireEvent.click(screen.getByRole("button", { name: /Create/ }));
  const send = await screen.findByRole("button", { name: "Send install event" });
  await waitFor(() => expect(send).not.toBeDisabled());
  fireEvent.click(send);
}

describe("RuntimeSetupModal team picker", () => {
  it("renders the team picker for superadmins and sends the selected teamId", async () => {
    await renderModal();
    const select = screen.getByLabelText("Team") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Global — usable by every team" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team One" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "t1" } });
    await driveToSend();

    expect(api.createRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({ teamId: "t1", agentCli: "opencode" }));
  });

  it("sends null for the Global choice", async () => {
    await renderModal();
    await driveToSend();
    expect(api.createRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({ teamId: null }));
  });

  it("hides the team picker for non-superadmins", async () => {
    role.isSuperadmin = false;
    role.teams = [];
    await renderModal();
    expect(screen.queryByLabelText("Team")).not.toBeInTheDocument();
  });
});
