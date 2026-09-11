// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Route components get no props from TanStack Router, so the route wrapper must
// read the verifyUrl's request id + token via `useSearch()` and pass them down.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => ({ request: "req-1", token: "tok" }),
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const h = vi.hoisted(() => ({
  session: { value: { user: { id: "u1" } } as { user: { id: string } } | null },
  request: { value: undefined as unknown },
}));

vi.mock("../lib/queries", () => ({
  useSession: () => ({ data: h.session.value, isLoading: false }),
  useSignIn: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceLoginRequest: () => h.request.value,
  useApproveDeviceLogin: () => ({ mutate: vi.fn() }),
  useDenyDeviceLogin: () => ({ mutate: vi.fn() }),
}));

import { DeviceLoginRoute } from "./device-login";

beforeEach(() => {
  h.session.value = { user: { id: "u1" } };
  h.request.value = {
    data: { status: "pending", clientName: "cli-laptop", code: "ABCD", expiresAt: new Date(Date.now() + 600_000).toISOString() },
    error: null,
    isLoading: false,
  };
});

describe("DeviceLoginRoute", () => {
  it("passes the request id + token from the URL to the page", () => {
    render(<DeviceLoginRoute />);
    expect(screen.getByText(/Approve this device\?/i)).toBeInTheDocument();
    expect(screen.queryByText(/Request not found/i)).toBeNull();
  });
});
