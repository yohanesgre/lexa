// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: null as { user: { id: string } } | null },
  request: { value: undefined as unknown },
}));

vi.mock("../../lib/auth", () => ({
  getSession: async () => ({ session: null, user: null }),
}));

vi.mock("../../lib/queries", () => ({
  useSession: () => ({ data: h.session.value, isLoading: false }),
  useSignIn: () => ({ mutate: vi.fn(), isPending: false }),
  useDeviceLoginRequest: () => h.request.value,
  useApproveDeviceLogin: () => ({ mutate: vi.fn() }),
  useDenyDeviceLogin: () => ({ mutate: vi.fn() }),
}));

import { DeviceLoginPage } from "./page";
import { Route as RootRoute } from "../../routes/__root";

beforeEach(() => {
  h.session.value = null;
  h.request.value = { data: undefined, error: null, isLoading: false };
});

describe("DeviceLoginPage", () => {
  it("renders the sign-in gate when there is no session", () => {
    render(<DeviceLoginPage request="req-1" token="tok" />);
    expect(screen.getByText(/Sign in to approve this device login/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByText(/Approve this device\?/i)).toBeNull();
  });

  it("renders the pending approve flow when a session exists", () => {
    h.session.value = { user: { id: "u1" } };
    h.request.value = {
      data: { status: "pending", clientName: "cli-laptop", code: "ABCD", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      error: null,
      isLoading: false,
    };
    render(<DeviceLoginPage request="req-1" token="tok" />);
    expect(screen.getByText(/Approve this device\?/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});

describe("root auth guard", () => {
  const beforeLoad = RootRoute.options.beforeLoad as unknown as (args: {
    location: { pathname: string; href: string };
  }) => Promise<unknown>;

  it("does not bounce an anonymous visitor off /device-login", async () => {
    await expect(
      beforeLoad({ location: { pathname: "/device-login", href: "/device-login?request=req-1&token=tok" } })
    ).resolves.toBeUndefined();
  });

  it("bounces an anonymous visitor off a protected path", async () => {
    await expect(
      beforeLoad({ location: { pathname: "/some-project/board", href: "/some-project/board" } })
    ).rejects.toMatchObject({ options: { to: "/login" } });
  });
});
